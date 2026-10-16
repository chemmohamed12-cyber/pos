const {Client}=require(process.cwd()+'/node_modules/pg');
const T=['1790014000000','1790015000000','1790015100000','1790015200000','1790015300000','1790015400000','1790016000000','1790016100000','1790016200000','1790016300000','1790016400000'];
(async()=>{for(const d of ['cp','co']){const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'daii_test_biz_t98_sim_'+d});await c.connect();
const n=(await c.query('select count(*)::int n from migrations')).rows[0].n;
const once=(await c.query('select timestamp::text ts,count(*)::int n from migrations where timestamp::text=ANY($1) group by 1',[T])).rows;
const dup=(await c.query('select count(*)::int n from (select timestamp from migrations group by 1 having count(*)>1) x')).rows[0].n;
const cols=(await c.query(`select table_name||'.'||column_name c from information_schema.columns where (table_name='customers' and column_name in ('partyType','legalName','email','website','language','internalNotes')) or (table_name='suppliers' and column_name in ('email','website','language','internalNotes')) or (table_name='products' and column_name in ('itemType','categoryId','defaultWarehouseId','reorderLevel','description'))`)).rows.length;
const tabs=(await c.query(`select table_name from information_schema.tables where table_name in ('product_categories','product_barcodes','customer_addresses','customer_contacts') order by 1`)).rows.map(r=>r.table_name);
console.log(d,'migrations',n,'| new migrations present once:',once.length+'/11 (all n=1: '+once.every(r=>r.n===1)+')','| legacy dup timestamps',dup,'| new columns',cols,'| new tables',tabs.join(','));await c.end()}})().catch(e=>console.log('ERR',e.message))
