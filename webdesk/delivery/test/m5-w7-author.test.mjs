/**
 * M5-W7 — the gaiada.com `author` collection composition: validated with the real composition validator, sample items
 * validated with the real item validator, and a deny-list proving no private-data field exists.
 * Run: cd webdesk/api && node --import tsx ../delivery/test/m5-w7-author.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateCollectionComposition, validateTenantComposition } from '../vocabulary/composition.ts'
import { validateItemContent } from '../vocabulary/item-fields.ts'
import { VOCABULARY_VERSION } from '../vocabulary/version.ts'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name} -- ${detail ?? ''}`)
  }
}
const load = (f) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../sites/gaiada-com/collections/${f}`, import.meta.url)), 'utf8'))
const clone = (v) => JSON.parse(JSON.stringify(v))
const ok = (v) => v.valid === true || (Array.isArray(v.issues) && v.issues.length === 0 && v.valid !== false)

const body = load('author.json')
check('author.json is exactly { schema }', Object.keys(body).join() === 'schema')
const schema = body.schema

const r = validateCollectionComposition('author', schema)
check('author composition validates clean', r.valid, JSON.stringify(r.issues))
check('author composition validates in a whole-tenant pass', validateTenantComposition({ author: schema }, { vocabularyVersion: VOCABULARY_VERSION }).valid)

// --- the deny-list: no private-data field name anywhere in the composition (recursive, any depth) ---
const DENY = /(e[-_]?mail|phone|mobile|whatsapp|telephone|^tel$|user[-_]?id|^sub$|erp|keycloak|account|address|street|birth|^dob$|gender|national|passport|^nik$|ssn|tax|salary|password|secret|token|ip[-_]?addr|employee|staff[-_]?id)/i
function names(fields, out = []) {
  for (const f of fields ?? []) {
    out.push(f.name)
    names(f.fields, out)
  }
  return out
}
const all = names(schema.fields)
const hits = all.filter((n) => DENY.test(n))
check('no private-data field name (deny-list)', hits.length === 0, hits.join(', '))
check('the deny-list bites (sanity)', ['email', 'phone_number', 'erp_user_id', 'userId', 'home_address', 'birthDate', 'sub'].every((n) => DENY.test(n)))
check('field set is exactly the public E-E-A-T set', [...all].sort().join() === ['bio', 'credentials', 'displayName', 'expertiseTopics', 'label', 'network', 'photo', 'photoAlt', 'profileLinks', 'published', 'roleTitle', 'url'].join(), all.join())
check('no relation to a user/account collection', !JSON.stringify(schema).includes('relationTo'))

// --- shape facts ---
const top = Object.fromEntries(schema.fields.map((f) => [f.name, f]))
check('localized collection (EN/ID twins)', schema.localized === true)
check('photo is media, photoAlt is text', top.photo.primitive === 'media' && top.photoAlt.primitive === 'text')
check('expertise topics and credentials are text lists', top.expertiseTopics.multiple === true && top.credentials.multiple === true && top.credentials.primitive === 'text')
check('published is a required boolean', top.published.primitive === 'boolean' && top.published.required === true)

// --- sample items against the real item validator ---
const good = [
  {
    type: 'fields',
    props: {
      displayName: 'Aulia Rahma',
      roleTitle: 'Head of SEO',
      bio: 'Aulia leads search at Gaiada.',
      expertiseTopics: ['Technical SEO'],
      credentials: ['Google Analytics certified'],
      photo: { url: 'https://media.example.test/aulia.jpg' },
      photoAlt: 'Aulia Rahma at her desk',
      profileLinks: [{ url: 'https://www.linkedin.com/in/example', network: 'linkedin' }],
      published: false,
    },
  },
]
const v = validateItemContent(schema, good)
check('a good sample item validates', ok(v), JSON.stringify(v))
const withEmail = clone(good)
withEmail[0].props.email = 'a@b.test'
check('an item carrying an email member is refused (closed field set)', !ok(validateItemContent(schema, withEmail)))
const bad = clone(good)
delete bad[0].props.displayName
check('missing displayName is refused', !ok(validateItemContent(schema, bad)))
const dupLinks = clone(good)
dupLinks[0].props.profileLinks.push({ url: 'https://www.linkedin.com/in/example', network: 'other' })
check('duplicate profile link url is refused (itemKey)', !ok(validateItemContent(schema, dupLinks)))
const badNet = clone(good)
badNet[0].props.profileLinks[0].network = 'myspace'
check('a network outside the allow-list is refused', !ok(validateItemContent(schema, badNet)))
// The vocabulary has no URL primitive: the rule the editor/import enforce, proven on the samples.
const https = (u) => {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}
check('sample link urls satisfy the https-only rule', good[0].props.profileLinks.every((l) => https(l.url)))
check('the https rule rejects javascript:, http: and junk', !https('javascript:alert(1)') && !https('http://x.test') && !https('not a url'))

// --- post delta ---
const d = load('post-author-field.json')
const f = d.addFields[0]
const post = { fields: [{ name: 'topic', primitive: 'text' }, f], blocks: ['richText'] }
const pr = validateCollectionComposition('post', post)
check('post composition with the author relation validates clean', pr.valid, JSON.stringify(pr.issues))
check('author relation points at the author collection', f.name === 'author' && f.primitive === 'relation' && f.relationTo === 'author')
const pv = validateItemContent(post, [{ type: 'fields', props: { topic: 'seo', author: { collection: 'author', slug: 'aulia-rahma' } } }])
check('a post item with { collection, slug } validates', ok(pv), JSON.stringify(pv))
const pv2 = validateItemContent(post, [{ type: 'fields', props: { topic: 'seo', author: '[CONFIRM: author name and role]' } }])
check('the "[CONFIRM ...]" literal is refused as an author value', !ok(pv2))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
