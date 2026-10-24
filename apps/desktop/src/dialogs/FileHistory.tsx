import { useEffect, useState } from 'react'
import type { Commit, HistoryEntry } from '../ipc/api'
import type { ShellView } from '../shell/Shell'
import { Glyph } from './icons'
import { Modal } from './index'
import type { DiffRow } from './diffRows'
import { baseName } from './logic'

type Version = { kind: 'save'; entry: HistoryEntry } | { kind: 'commit'; commit: Commit }

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const ROW_CLASS: Record<DiffRow['kind'], string> = { hunk: 'hh', add: 'hl a', del: 'hl d', ctx: 'hl' }
const SIGN: Record<DiffRow['kind'], string> = { hunk: '', add: '+', del: '-', ctx: ' ' }

/** Local saves and commits of one file; a save diffs against the file now, a commit shows what it changed */
export function FileHistory({ view, root, file, onClose }: { view: ShellView; root: string; file: string; onClose: () => void }) {
  const { api } = view
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [index, setIndex] = useState(0)
  const [diff, setDiff] = useState<DiffRow[] | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([api.listHistory(root, file).catch(() => []), api.fileLog(root, file).catch(() => [])]).then(([saves, commits]) => {
      if (!cancelled) setVersions([...saves.map((entry): Version => ({ kind: 'save', entry })), ...commits.map((commit): Version => ({ kind: 'commit', commit }))])
    })
    return () => {
      cancelled = true
    }
  }, [api, root, file])

  const version = versions?.[index]
  useEffect(() => {
    if (!version) return
    let cancelled = false
    setDiff(null)
    const rows = import('./diffRows').then(({ patchRows, versionRows }) =>
      version.kind === 'commit'
        ? api.commitDiff(root, version.commit.sha, file).then((patches) => patches.flatMap((p) => patchRows(p.patch)))
        : Promise.all([api.readHistory(root, file, version.entry.id), api.readFile(root, file)]).then(([saved, now]) => versionRows(file, saved, now ?? ''))
    )
    void rows.then(
      (r) => !cancelled && setDiff(r),
      () => !cancelled && setDiff([])
    )
    return () => {
      cancelled = true
    }
  }, [api, root, file, version])

  const restore = async () => {
    if (!version) return
    try {
      const contents = version.kind === 'commit' ? await api.readFileAt(root, file, version.commit.sha) : await api.readHistory(root, file, version.entry.id)
      if (contents === null) return setNote('That version is binary or missing: nothing to restore')
      await api.saveFile(root, file, contents, await api.readFile(root, file))
      setNote(`Restored from ${version.kind === 'commit' ? version.commit.sha : `the save of ${when(version.entry.savedAt)}`}`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal className="fh" onClose={onClose}>
      <h3>
        <Glyph name="history" />
        History of {baseName(file)}
      </h3>
      <div className="fhgrid">
        <div className="fhl">
          {versions?.length === 0 && <div className="empty">No saves or commits yet</div>}
          {versions?.map((v, i) => (
            <div key={v.kind === 'save' ? v.entry.id : v.commit.sha}>
              {v.kind !== versions[i - 1]?.kind && <div className="mlabel">{v.kind === 'save' ? 'Local saves' : 'Commits'}</div>}
              <button className={`mi ${i === index ? 'on' : ''}`} onClick={() => setIndex(i)}>
                {v.kind === 'save' ? (
                  <>
                    <span className="trunc">Saved {when(v.entry.savedAt)}</span>
                    <span className="d mono">{(v.entry.bytes / 1024).toFixed(1)} KB</span>
                  </>
                ) : (
                  <>
                    <span className="trunc">{v.commit.subject}</span>
                    <span className="d mono">
                      {v.commit.sha} · {v.commit.author} · {when(v.commit.date * 1000)}
                    </span>
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
        <div className="fhd">
          {version && (
            <div className="dim mono" style={{ padding: '0 8px 6px' }}>
              {version.kind === 'commit' ? `${version.commit.sha} ${file}` : `${file}: the save vs now`}
            </div>
          )}
          {diff?.length === 0 && <div className="empty">No differences</div>}
          {diff?.map((r, i) => (
            <div key={i} className={ROW_CLASS[r.kind]}>
              {r.kind === 'hunk' ? r.text : `${SIGN[r.kind]} ${r.text}`}
            </div>
          ))}
        </div>
      </div>
      <div className="mft">
        <span className="dim trunc">{note}</span>
        <button className="btn" disabled={!version} onClick={() => void restore()}>
          Restore this version
        </button>
        <button className="btn pri" autoFocus onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
