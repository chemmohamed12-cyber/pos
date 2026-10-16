const {Client}=require(process.cwd()+'/node_modules/pg');
(async()=>{const q=async(d,s)=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:d});await c.connect();const r=(await c.query(s)).rows;await c.end();return r};
const cp='daii_test_biz_t98_sim_cp';const o={};
o.platform=(await q(cp,`select (select count(*) from audit_records)::int audit,(select count(*) from backup_runs)::int backups,(select count(*) from migrations)::int migrations`))[0];
o.companies=(await q(cp,`select name,status from companies where name in ('A-Verify','B-Fail','C-After') order by name`)).map(r=>r.name+':'+r.status).join(' ');
for(const [n,d] of [['A','co'],['B','co2'],['C','co3']])o['mig_'+n]=(await q('daii_test_biz_t98_sim_'+d,'select count(*)::int n from migrations'))[0].n;
console.log(JSON.stringify(o))})()
