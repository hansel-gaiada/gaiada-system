import config from '@payload-config'
import { NotFoundPage } from '@payloadcms/next/views'

import { importMap } from '../importMap.js'

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

// WSK-02 fix: the spike's version of this file also imported `generateNotFoundViewMetadata` from
// `@payloadcms/next/views`, but that barrel (node_modules/@payloadcms/next/dist/exports/views.js,
// pinned at 3.88.0) re-exports `NotFoundPage` from `views/NotFound/index.js` but NOT
// `generateNotFoundViewMetadata` — confirmed by reading that file directly, not assumed. Importing
// it produced a real "Attempted import error" warning on every admin request in this project
// (harmless today — nothing calls this route's `generateMetadata` in this ticket's tests, since no
// test hits a genuine 404 inside /admin — but worth not shipping a broken import). Dropped the
// metadata export; the page still renders (metadata falls back to the parent layout's).
const NotFound = ({ params, searchParams }: Args) =>
  NotFoundPage({ config, importMap, params, searchParams })

export default NotFound
