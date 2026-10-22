import { useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Api } from '../../ipc/api'
import { IN_TAURI } from '../../lib/native'
import { Binary } from './TextFile'

export const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i
export const PDF_PATH = /\.pdf$/i

/** The asset protocol in the app; the dev server's file route in the browser build */
const fileUrl = (path: string): string => (IN_TAURI ? convertFileSrc(path) : `/@fs${path}`)

/** Pictures on a checkerboard so transparency reads, PDFs in WebKit's viewer; anything that won't load offers the default app */
export function Media({ api, root, file }: { api: Api; root: string; file: string }) {
  const [size, setSize] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const src = fileUrl(`${root}/${file}`)
  if (failed) return <Binary api={api} root={root} file={file} />
  if (PDF_PATH.test(file)) return <iframe className="fv-pdf" title={file} src={src} />
  return (
    <div className="fv-body">
      <div className="fv-image">
        <img src={src} alt={file} onError={() => setFailed(true)} onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      </div>
      {size && <div className="fv-size dim">{size}</div>}
    </div>
  )
}
