const base=process.argv[2];const J={'Content-Type':'application/json'};const out=[];const rec=(n,ok,d)=>out.push([ok?'PASS':'FAIL',n,d??''].join(' | '));
(async()=>{const l=await (await fetch(base+'/api/auth/login',{method:'POST',headers:J,body:JSON.stringify({email:'bv.admin@example.test',password:'BvAdmin#2026'})})).json();
const sc=await (await fetch(base+'/api/auth/select-company',{method:'POST',headers:{...J,Authorization:'Bearer '+l.data.accessToken},body:JSON.stringify({companyId:process.env.SIM_COMPANY_ID})})).json();const H={...J,Authorization:'Bearer '+sc.data.accessToken};
const P=async(p,b)=>{const r=await fetch(base+'/api'+p,{method:'POST',headers:H,body:JSON.stringify(b??{})});let j={};try{j=await r.json()}catch{}return {s:r.status,j}};const G=async p=>{const r=await fetch(base+'/api'+p,{headers:H});let j={};try{j=await r.json()}catch{}return {s:r.status,j}};
const U=String(Date.now()).slice(-7),BC='62299'+U;const p1=await P('/products',{sku:'SIM-A'+U,name:'Sim Item 1',unitPrice:'10.00'});rec('create product 1',p1.s===201,p1.s);const p2=await P('/products',{sku:'SIM-B'+U,name:'Sim Item 2',unitPrice:'12.00'});rec('create product 2',p2.s===201,p2.s);
const id1=p1.j.data?.id,id2=p2.j.data?.id;
const b1=await P(`/products/${id1}/barcodes`,{barcode:BC});rec('add barcode (new migration table)',b1.s===201,b1.s);
const dup=await P(`/products/${id2}/barcodes`,{barcode:BC});rec('duplicate barcode on another item is refused (409)',dup.s===409,dup.s+' '+(dup.j.error?.message??''));
const lk=await G('/products/lookup?code='+BC+'');rec('lookup by barcode resolves the item',lk.s===200&&lk.j.data?.product?.id===id1,lk.s+' matchedBy='+lk.j.data?.matchedBy);
const lk2=await G('/products/lookup?code=SIM-B'+U+'');rec('lookup by SKU',lk2.s===200&&lk2.j.data?.product?.id===id2,lk2.s);
const cu=await G('/customers');const cid=(cu.j.data?.items??cu.j.data)[0]?.id;
const ct=await P(`/customers/${cid}/contacts`,{name:'Sim Contact',phone:'0100000077',isPrimary:true});rec('customer contact (new table)',ct.s===201,ct.s);
const ad=await P(`/customers/${cid}/addresses`,{addressLine:'1 Sim Street',city:'Cairo',isDefault:true});rec('customer address (new table)',ad.s===201,ad.s+(ad.s>=300?' '+JSON.stringify(ad.j).slice(0,140):''));
const pr=await G(`/customers/${cid}/profile`);rec('customer profile aggregates contacts+addresses',pr.s===200&&pr.j.data?.contacts?.length>=1&&pr.j.data?.addresses?.length>=1,pr.s);
const su=await G('/procurement/suppliers');const sid=(su.j.data?.items??su.j.data)[0]?.id;
const su2=await P(`/procurement/suppliers/${sid}/update`,{email:'supplier@example.test',language:'ar'});rec('supplier profile update (new columns)',su2.s<300,su2.s);
const pol=await G(`/procurement/purchase-orders?supplierId=${sid}`);rec('PO list filtered by supplier (new param)',pol.s===200,pol.s);
const iso=await fetch(base+'/api/customers',{headers:{Authorization:'Bearer '+l.data.accessToken}});rec('company isolation: platform-scope token (no company) is refused on a company route',iso.status===403,iso.status);
console.log(out.join('\n'));console.log('TOTAL',out.filter(x=>x.startsWith('PASS')).length,'pass',out.filter(x=>x.startsWith('FAIL')).length,'fail')})().catch(e=>{console.log(out.join('\n'));console.error(e);process.exit(1)})
