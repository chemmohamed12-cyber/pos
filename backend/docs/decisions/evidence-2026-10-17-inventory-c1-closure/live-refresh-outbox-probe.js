const {Client}=require('pg');
(async()=>{const c=new Client({host:'127.0.0.1',port:5546,user:'daii_biz_test',password:process.env.PW,database:'daii_test_biz_t97_c1_co'});await c.connect();
const a=process.argv[2];
if(a==='pending') await c.query(`INSERT INTO event_outbox(topic,payload,status) VALUES ('inventory.movement.recorded','{"c1probe":true}','processing')`);
if(a==='failed') await c.query(`UPDATE event_outbox SET status='failed',attempts=5 WHERE payload->>'c1probe'='true'`);
if(a==='clear') await c.query(`DELETE FROM event_outbox WHERE payload->>'c1probe'='true'`);
console.log(a,(await c.query(`SELECT status,count(*) FROM event_outbox GROUP BY 1`)).rows);
await c.end()})()
