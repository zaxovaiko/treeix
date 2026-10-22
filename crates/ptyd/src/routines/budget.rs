//! Run budgets: `--max-turns` goes on the command line; cost is read from the run's transcript (Claude
//! `~/.claude/projects/**/<session>.jsonl`, Codex rollouts) while it runs, and the run is killed past
//! `Budget.max_cost`. Owner: R6

use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use treeix_core::agents::usage::{self, Price};
use treeix_proto::chat::ChatAgent;
use treeix_proto::routines::Budget;

/// Turns and USD a run spent so far
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Spent {
    pub turns: u32,
    pub cost: f64,
}

/// The price list `agentUsage` keeps in the data dir (`usage::refresh_prices`); empty until it was fetched once
pub fn prices(data_dir: &Path) -> BTreeMap<String, Price> {
    std::fs::read(data_dir.join("prices.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|saved| serde_json::from_value(saved.get("prices")?.clone()).ok())
        .unwrap_or_default()
}

fn cost(prices: &BTreeMap<String, Price>, model: &str, tokens: [u64; 4]) -> f64 {
    usage::price_of(prices, model).map_or(0.0, |price| {
        price.iter().zip(tokens).map(|(p, t)| p * t as f64).sum()
    })
}

/// Reads a transcript from the start; unreadable lines are skipped. A turn is one model reply
pub fn spent(agent: ChatAgent, transcript: &str, prices: &BTreeMap<String, Price>) -> Spent {
    match agent {
        ChatAgent::Claude => claude_spent(transcript, prices),
        ChatAgent::Codex => {
            let rows = usage::codex_rows(transcript.lines(), "").rows;
            Spent {
                turns: transcript
                    .lines()
                    .filter(|l| {
                        l.contains("\"token_count\"") && l.contains("\"total_token_usage\"")
                    })
                    .count() as u32,
                cost: rows
                    .iter()
                    .map(|r| {
                        let tokens = [r.input, r.output, r.cache_read, r.cache_write];
                        cost(prices, &r.model, tokens)
                    })
                    .sum(),
            }
        }
    }
}

/// Claude repeats a reply's usage on each of its content block lines, so replies count once by id
fn claude_spent(transcript: &str, prices: &BTreeMap<String, Price>) -> Spent {
    let mut seen = HashSet::new();
    let mut spent = Spent::default();
    for line in transcript.lines().filter(|l| l.contains("\"usage\"")) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(message) = entry
            .get("message")
            .filter(|_| entry.get("type").and_then(Value::as_str) == Some("assistant"))
        else {
            continue;
        };
        let (Some(id), Some(tokens)) = (
            message.get("id").and_then(Value::as_str),
            message.get("usage").filter(|u| u.is_object()),
        ) else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let count = |key: &str| tokens.get(key).and_then(Value::as_u64).unwrap_or(0);
        let model = message.get("model").and_then(Value::as_str).unwrap_or("");
        spent.turns += 1;
        spent.cost += cost(
            prices,
            model,
            [
                count("input_tokens"),
                count("output_tokens"),
                count("cache_read_input_tokens"),
                count("cache_creation_input_tokens"),
            ],
        );
    }
    spent
}

/// Why the run must stop, like `Stopped at the $5.00 budget`; None while within it
pub fn breach(budget: &Budget, spent: Spent) -> Option<String> {
    if let Some(max) = budget.max_cost.filter(|&max| spent.cost >= max) {
        return Some(format!("Stopped at the ${max:.2} budget"));
    }
    budget
        .max_turns
        .filter(|&max| spent.turns > max)
        .map(|max| format!("Stopped after {max} turns"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prices() -> BTreeMap<String, Price> {
        // Powers of two, so sums are exact: $1 per 2^20 input tokens, $1 per 2^17 output tokens
        let (input, output) = (1.0 / 1_048_576.0, 1.0 / 131_072.0);
        BTreeMap::from([("claude-opus-5".to_owned(), [input, output, 0.0, 0.0])])
    }

    fn reply(id: &str, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{id}","model":"claude-opus-5-20260101","usage":{{"input_tokens":1048576,"output_tokens":{output}}}}}}}"#
        )
    }

    #[test]
    fn claude_replies_count_once_however_many_blocks_they_have() {
        let transcript = [
            reply("a", 131_072),
            reply("a", 131_072),
            r#"{"type":"user","message":{"content":"hi"}}"#.into(),
            "not json".into(),
            reply("b", 0),
        ]
        .join("\n");
        let spent = spent(ChatAgent::Claude, &transcript, &prices());
        assert_eq!(spent.turns, 2);
        assert_eq!(spent.cost, 3.0);
    }

    #[test]
    fn unknown_models_cost_nothing_but_still_count_turns() {
        let spent = spent(ChatAgent::Claude, &reply("a", 5), &BTreeMap::new());
        assert_eq!(
            spent,
            Spent {
                turns: 1,
                cost: 0.0
            }
        );
    }

    #[test]
    fn breach_names_the_limit_it_hit() {
        let budget = Budget {
            max_turns: Some(10),
            max_cost: Some(5.0),
        };
        let within = Spent {
            turns: 10,
            cost: 4.99,
        };
        assert_eq!(breach(&budget, within), None);
        assert_eq!(
            breach(
                &budget,
                Spent {
                    turns: 3,
                    cost: 5.0
                }
            )
            .as_deref(),
            Some("Stopped at the $5.00 budget")
        );
        assert_eq!(
            breach(
                &budget,
                Spent {
                    turns: 11,
                    cost: 0.0
                }
            )
            .as_deref(),
            Some("Stopped after 10 turns")
        );
        assert_eq!(
            breach(
                &Budget::default(),
                Spent {
                    turns: 99,
                    cost: 99.0
                }
            ),
            None
        );
    }

    #[test]
    fn a_growing_transcript_crosses_the_budget() {
        let budget = Budget {
            max_turns: None,
            max_cost: Some(5.0),
        };
        let mut transcript = String::new();
        let mut stopped = None;
        for (n, id) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            transcript.push_str(&reply(id, 0));
            transcript.push('\n');
            if let Some(reason) = breach(&budget, spent(ChatAgent::Claude, &transcript, &prices()))
            {
                stopped = Some((n + 1, reason));
                break;
            }
        }
        assert_eq!(stopped, Some((5, "Stopped at the $5.00 budget".into())));
    }
}
