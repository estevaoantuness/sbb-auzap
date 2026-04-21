const { Parser } = require('node-sql-parser')
const p = new Parser()
const sql = `SELECT 1 FROM petshop_appointments pa INNER JOIN clients c ON c.id = pa.client_id AND pa.company_id = 6 AND c.company_id = 6 WHERE c.name ILIKE '%x%' LIMIT 10`
const ast = p.parse(sql, { database: 'postgresql' }).ast
console.log(JSON.stringify(ast.from, null, 2))
