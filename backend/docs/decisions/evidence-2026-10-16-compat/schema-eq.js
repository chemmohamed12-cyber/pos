const {Client}=require(process.cwd()+'/node_modules/pg');
const q=`select 'col '||table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'') x from information_schema.columns where table_schema='public'
union all select 'idx '||tablename||' '||indexdef from pg_indexes where schemaname='public'
union all select 'con '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace order by 1`;
async function snap(d){const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:d});await c.connect();const r=(await c.query(q)).rows.map(r=>r.x);await c.end();return r}
(async()=>{const a=await snap('daii_test_biz_t98_fresh'),b=await snap('daii_test_biz_t98_sim_co'),c=await snap('daii_test_biz_t98_sim_cp');
const diff=(x,y)=>({onlyA:x.filter(v=>!y.includes(v)),onlyB:y.filter(v=>!x.includes(v))});
const d1=diff(a,b);console.log('fresh-1.1.10 vs upgraded-company(1.1.9->1.1.10): objects',a.length,b.length,'onlyFresh',d1.onlyA.length,'onlyUpgraded',d1.onlyB.length);d1.onlyA.slice(0,5).concat(d1.onlyB.slice(0,5)).forEach(x=>console.log('  ',x.slice(0,160)));
const d2=diff(a,c);console.log('fresh-1.1.10 vs upgraded-platform: onlyFresh',d2.onlyA.length,'onlyUpgraded',d2.onlyB.length);d2.onlyA.slice(0,5).concat(d2.onlyB.slice(0,5)).forEach(x=>console.log('  ',x.slice(0,160)))})()
