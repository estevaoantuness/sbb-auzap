/**
 * Smoke tests for tenant SQL policy (build dist first: npm run build).
 * Run: node scripts/sql-tenant-policy-smoke.cjs
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validatePetshopReadOnlySql } = require('../dist/secondBrain/sql/sqlValidator.js')

const TENANT = 6
const MAX = 50

function mustPass(label, sql) {
  const r = validatePetshopReadOnlySql(sql, TENANT, MAX)
  if (!r.ok) {
    console.error(`FAIL expected PASS [${label}]:`, r)
    process.exit(1)
  }
}

function mustFail(label, sql, codeSubstring) {
  const r = validatePetshopReadOnlySql(sql, TENANT, MAX)
  if (r.ok) {
    console.error(`FAIL expected FAIL [${label}]`)
    process.exit(1)
  }
  if (codeSubstring && r.code !== codeSubstring && !String(r.message || '').includes(codeSubstring)) {
    console.error(`FAIL [${label}] wrong error:`, r, 'expected code/message hint:', codeSubstring)
    process.exit(1)
  }
}

// PASS: company_id only on INNER JOIN ON (qualified), both allowed tables
mustPass(
  'inner-on-both-aliases',
  `SELECT pa.id, c.full_name
FROM petshop_appointments pa
INNER JOIN clients c ON pa.client_id = c.id AND pa.company_id = 6 AND c.company_id = 6
WHERE c.full_name ILIKE '%igor%'
LIMIT 20`,
)

// PASS: FK-style JOIN ON ps.company_id = pa.company_id (sem literal no ON) + tenant no WHERE
mustPass(
  'inner-on-company-id-equals-alias',
  `SELECT pa.id AS appointment_id, pa.scheduled_date, ps.name AS service_name
FROM petshop_appointments pa
INNER JOIN petshop_services ps ON ps.id = pa.service_id AND ps.company_id = pa.company_id
INNER JOIN clients c ON c.id = pa.client_id AND c.company_id = pa.company_id
WHERE pa.company_id = 6 AND pa.scheduled_date >= DATE '2026-04-04' AND pa.status NOT IN ('cancelled', 'no_show')
ORDER BY pa.scheduled_date ASC
LIMIT 50`,
)

// PASS: legacy unqualified company_id in WHERE (multi-table INNER)
mustPass(
  'where-unqualified-company-id',
  `SELECT pa.id
FROM petshop_appointments pa
INNER JOIN clients c ON pa.client_id = c.id
WHERE company_id = 6
LIMIT 10`,
)

// FAIL: LEFT JOIN — ON não conta; sem company_id no WHERE
mustFail(
  'left-join-on-only',
  `SELECT pa.id, c.full_name
FROM clients c
LEFT JOIN petshop_appointments pa ON pa.company_id = 6 AND pa.client_id = c.id
WHERE c.full_name ILIKE '%igor%'
LIMIT 20`,
  'TENANT',
)

// FAIL: INNER mas falta company_id em um dos aliases
mustFail(
  'inner-missing-one-alias',
  `SELECT pa.id, c.full_name
FROM petshop_appointments pa
INNER JOIN clients c ON pa.client_id = c.id AND pa.company_id = 6
WHERE c.full_name ILIKE '%x%'
LIMIT 20`,
  'TENANT',
)

// FAIL: OR no ON — não contamos para cobertura
mustFail(
  'inner-on-with-or',
  `SELECT pa.id
FROM petshop_appointments pa
INNER JOIN clients c ON pa.client_id = c.id AND (c.company_id = 6 OR c.id = 1) AND pa.company_id = 6
LIMIT 20`,
  'TENANT',
)

// FAIL: company_id com valor errado no ON
mustFail(
  'inner-on-wrong-tenant',
  `SELECT pa.id
FROM petshop_appointments pa
INNER JOIN clients c ON pa.client_id = c.id AND pa.company_id = 6 AND c.company_id = 999
LIMIT 20`,
  'company_id deve ser igual',
)

console.log('sql-tenant-policy-smoke: all checks passed')
