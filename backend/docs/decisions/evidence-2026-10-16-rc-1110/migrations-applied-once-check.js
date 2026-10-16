const fs=require('fs');
const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const {Client}=require(process.cwd()+'/node_modules/pg');
const T=['1790014000000','1790015000000','1790015100000','1790015200000','1790015300000','1790015400000','1790016000000','1790016100000','1790016200000','1790016300000','1790016400000'];
const conn=db=>new Client({host:env.DB_HOST,port:Number(env.DB_PORT),user:env.DB_USER,password:env.DB_PASSWORD,database:db});
(async()=>{const c=conn(env.DB_NAME);await c.connect();await c.query('SET default_transaction_read_only = on');
const reg=(await c.query(`SELECT r."databaseName",co.name FROM database_registries r LEFT JOIN companies co ON co.id=r."companyId" WHERE r."databaseName" IS NOT NULL`)).rows;
const targets=[{n:'platform',db:env.DB_NAME},...reg.map(r=>({n:r.name,db:r.databaseName}))];
for(const t of targets){const k=conn(t.db);await k.connect();const rows=(await k.query('SELECT timestamp::text ts,count(*)::int n FROM migrations WHERE timestamp::text = ANY($1) GROUP BY 1 ORDER BY 1',[T])).rows;const dups=(await k.query('SELECT timestamp::text ts,count(*)::int n FROM migrations GROUP BY 1 HAVING count(*)>1')).rows;await k.end();
console.log(t.n.padEnd(8),'present',rows.map(r=>r.ts.slice(7,10)+'x'+r.n).join(' '),'| duplicates in whole table:',dups.length)}
await c.end()})().catch(e=>{console.error(e.message);process.exit(1)});
