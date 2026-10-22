#!/bin/sh
# Phase 0 terminal bench: `sh bench/run.sh` writes bench/results/<date>-<machine>.json.
# Parts that can't run on this machine are recorded as {"skipped": "<why>"}. See bench/README.md.
set -u
cd "$(dirname "$0")/.."
DIR=/tmp/treeix-bench
RUNS=${RUNS:-5}
MIXED=$DIR/mixed-100m.ans
machine=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)
out=bench/results/$(date +%F)-$(echo "$machine" | tr -cs 'A-Za-z0-9' '-' | sed 's/-$//').json
# The user may be away: keep the display and machine awake for the GUI runs
command -v caffeinate >/dev/null && caffeinate -d -i -w $$ &
skipped() { printf '{"skipped":"%s"}' "$1"; }
median() { sort -n | awk '{ a[NR] = $1 } END { if (NR) print a[int((NR + 1) / 2)] }'; }

bun bench/gen.ts "$DIR" >/dev/null || exit 1
mb=$(( $(wc -c < "$MIXED") / 1048576 ))

# (1) ptyd headless, built by crates/ptyd/src/bin/ptyd-bench.rs
ptyd() {
  target=${CARGO_TARGET_DIR:-target}
  if cargo build --release -q -p treeix-ptyd --bin ptyd-bench 2>/dev/null && json=$("$target/release/ptyd-bench" --in-process "$MIXED" 2>/dev/null) && [ -n "$json" ]; then
    echo "$json"
  else
    skipped "ptyd-bench not built or printed nothing"
  fi
}

# (2) Ghostty: wall time of cat inside a fresh Ghostty window, median of RUNS. Ghostty reads the pty on its IO thread
# and parses as it reads, so cat's time is its parse throughput
ghostty() {
  app=${GHOSTTY_APP:-/Applications/Ghostty.app}
  [ -d "$app" ] || { skipped "Ghostty not installed (brew install --cask ghostty)"; return; }
  times=""
  for run in $(seq 1 "$RUNS"); do
    result=$DIR/ghostty-$run.txt
    rm -f "$result"
    open -na "$app" --args --config-default-files=false --quit-after-last-window-closed=true --wait-after-command=false \
      --window-width=120 --window-height=40 -e "$DIR/timed-cat.sh" "$MIXED" "$result"
    for _ in $(seq 1 180); do [ -s "$result" ] && break; sleep 1; done
    [ -s "$result" ] || { pkill -f "$app/Contents/MacOS/ghostty" ; skipped "no result in 180 s: first-launch Gatekeeper dialog or a locked screen"; return; }
    times="$times $(awk '{ printf "%.3f", $2 - $1 }' "$result")"
    sleep 2
  done
  secs=$(echo "$times" | tr ' ' '\n' | grep . | median)
  printf '{"file":"%s","mb":%s,"runs":[%s],"medianSeconds":%s,"mbPerSecond":%s}' "$MIXED" "$mb" "$(echo $times | tr ' ' ',')" "$secs" \
    "$(awk -v mb="$mb" -v s="$secs" 'BEGIN { printf "%.1f", mb / s }')"
}

cat > "$DIR/timed-cat.sh" <<'EOF'
#!/bin/sh
# timed-cat.sh <file> <result>: wall seconds of cat inside whatever terminal runs it
start=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')
cat "$1"
end=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')
echo "$start $end" > "$2"
EOF
chmod +x "$DIR/timed-cat.sh"

echo "ptyd..." >&2; p=$(ptyd)
echo "ghostty..." >&2; g=$(ghostty)
echo "frontend..." >&2; r=$(node bench/reveal.mts 2>/dev/null | tail -1)
mkdir -p bench/results
cat > "$out" <<EOF
{
  "date": "$(date -u +%FT%TZ)",
  "machine": "$machine",
  "macos": "$(sw_vers -productVersion 2>/dev/null || uname -r)",
  "ptyd": ${p:-null},
  "ghostty": ${g:-null},
  "frontendOnly": ${r:-null},
  "tauri": {"pending": "TREEIX_AUTORUN=bench in a release build, see bench/README.md"}
}
EOF
echo "$out"
cat "$out"
