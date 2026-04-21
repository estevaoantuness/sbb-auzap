const { Parser } = require('node-sql-parser')
const p = new Parser()
const sql = `SELECT * FROM clients c LEFT JOIN petshop_appointments pa ON pa.client_id = c.id AND pa.company_id = 6 WHERE c.name ILIKE '%x%' LIMIT 10`
const ast = p.parse(sql, { database: 'postgresql' }).ast
console.log(JSON.stringify(ast.from[1], null, 2))
