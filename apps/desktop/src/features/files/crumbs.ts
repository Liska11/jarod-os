import { formatPath, parsePath, segmentsBelow } from '../../../shared/host-path.ts'
import { diskLabel } from '../../lib/platform-labels.ts'
import type { Location } from './files-store.ts'

export interface Crumb {
  label: string
  location: Location
}

/**
 * The breadcrumb for `location`: from the space's root folder when inside it, from Home when inside that, else from the disk or
 * share it lives on (`Local Disk (C:)`, `\\nas\photos`, `Macintosh HD`). Works on Windows paths as on POSIX ones.
 */
export function buildCrumbs(location: Location | null, root: string | null, rootLabel: string, home: string | null, platform: NodeJS.Platform | 'unknown'): Crumb[] {
  if (!location || !root) {
    return []
  }

  const rootCrumb: Crumb = { label: rootLabel, location: { kind: 'dir', path: root } }

  if (location.kind === 'recent') {
    return [rootCrumb, { label: 'Recent', location }]
  }

  if (location.kind === 'favorites') {
    return [rootCrumb, { label: 'Favorites', location }]
  }

  const parsed = parsePath(location.path)
  let base: Crumb
  let rest = segmentsBelow(location.path, root)

  if (rest) {
    base = rootCrumb
  } else if (home && (rest = segmentsBelow(location.path, home))) {
    base = { label: 'Home', location: { kind: 'dir', path: home } }
  } else {
    const drive = parsed.root || '/'
    base = { label: drive.startsWith('\\\\') ? drive.replace(/\\$/, '') : diskLabel(drive, platform), location: { kind: 'dir', path: drive } }
    rest = parsed.segments
  }

  const crumbs = [base]
  const start = parsePath(base.location.kind === 'dir' ? base.location.path : '/')

  rest.forEach((segment, index) => {
    const path = formatPath({ ...start, segments: [...start.segments, ...rest.slice(0, index + 1)] })
    crumbs.push({ label: segment === '.Trash' ? 'Trash' : segment, location: { kind: 'dir', path } })
  })

  return crumbs
}
