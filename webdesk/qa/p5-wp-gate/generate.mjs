// webdesk/qa/p5-wp-gate/generate.mjs -- M6 P5 gate: generates the tenant's contract LIVE, then reads the
// stored sdk.php back out of RustFS.
//
// Runs INSIDE the built api image (cwd /app) against the image's own compiled generator bundle
// (dist/codegen/generator.mjs, M6-P4r-a), fed on stdin by p5-wp-gate.sh:   node --input-type=module - < generate.mjs
// Env: APP_DATABASE_URL (webdesk_app, NOBYPASSRLS, as the api itself) + the STORAGE_* set + GEN_TENANT_SLUG.
//
// stdout is the stored sdk.php BYTES and nothing else (the shell redirects it to a file); every log line
// goes to stderr. Exit 0 only when: the generation ran, latest.json names contracts/<slug>/<version>/sdk.php,
// the object read back from RustFS is byte-identical to what the generator built, and it declares getPages().
import pg from 'pg'

const m = await import('file:///app/dist/codegen/generator.mjs')
const slug = process.env.GEN_TENANT_SLUG
if (!slug || !process.env.APP_DATABASE_URL) {
  console.error('generate: GEN_TENANT_SLUG and APP_DATABASE_URL are required')
  process.exit(2)
}
const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL })
let sdk
try {
  const storage = m.createGeneratorStorageAdapter()
  const result = await m.generateTenantContract(pool, storage, slug)
  if (!result) throw new Error(`no active tenant "${slug}"`)
  const pointer = await m.readLatestPointer(storage, slug)
  if (!pointer) throw new Error('latest.json was not written')
  const expectedKey = `contracts/${slug}/${pointer.contractVersion}/sdk.php`
  if (pointer.artifactKeys.sdkPhp !== expectedKey) throw new Error(`pointer sdkPhp key ${pointer.artifactKeys.sdkPhp} != ${expectedKey}`)
  const bucket = process.env.STORAGE_BUCKET_ARTIFACTS || 'artifacts'
  const obj = await storage.getObject(bucket, expectedKey)
  sdk = obj.body
  if (sdk.toString('utf8') !== result.built.sdkPhp) throw new Error('stored sdk.php differs from the generated one')
  if (!sdk.toString('utf8').includes('function getPages(')) throw new Error('generated sdk.php has no getPages() (pages collection missing from the contract)')
  console.error(`generate: contract ${pointer.contractVersion} (vocabulary ${pointer.vocabularyVersion}); ${expectedKey} = ${sdk.length} bytes, read back from RustFS`)
} catch (err) {
  console.error('generate FAILED:', err)
  process.exit(1)
} finally {
  await pool.end()
}
process.stdout.write(sdk)
