import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const env = process.env;
const app = express();
const uploadDir = path.resolve(root, env.UPLOAD_DIR || 'server/uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const dbPath = path.resolve(root, env.DATABASE_PATH || 'server/kinetic-grooves.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', price INTEGER NOT NULL,
 category TEXT NOT NULL, sizes_json TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
 image TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, gateway_order_id TEXT UNIQUE, amount INTEGER NOT NULL, status TEXT NOT NULL,
 payment_method TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT, customer_phone TEXT,
 address TEXT NOT NULL, city TEXT NOT NULL, pincode TEXT NOT NULL, items_json TEXT NOT NULL,
 created_at TEXT NOT NULL, utr TEXT
);
CREATE TABLE IF NOT EXISTS order_email_notifications (order_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS merch_factory_webhook_events (event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
`);
for (const [column, definition] of [['payment_provider',"TEXT NOT NULL DEFAULT 'famgateway'"],['address2',"TEXT NOT NULL DEFAULT ''"],['mf_order_id',"TEXT"],['mf_status',"TEXT NOT NULL DEFAULT 'not_submitted'"],['mf_error',"TEXT"]]) {
  try { db.exec("ALTER TABLE orders ADD COLUMN " + column + " " + definition); }
  catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
}
const initialProducts = JSON.parse(fs.readFileSync(path.join(root, 'shared/products.json'), 'utf8'));
// Remove the original demo catalogue when deploying the real Drop 001 seed.
// Existing orders remain intact because their item details are stored as snapshots.
db.prepare(`DELETE FROM products WHERE id IN ('signature-tee','infinite-tee','evolve-tee','core-hoodie','nemesis-hoodie','vector-cargo')`).run();
const insertSeed = db.prepare(`INSERT OR IGNORE INTO products (id,name,description,price,category,sizes_json,stock,image,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
for (const p of initialProducts) insertSeed.run(p.id,p.name,p.description,p.price,p.category,JSON.stringify(p.sizes || ['S','M','L','XL']),Number.isInteger(p.stock) ? p.stock : 0,p.image || '', ['active','draft','archived'].includes(p.status) ? p.status : 'draft',new Date().toISOString(),new Date().toISOString());

app.disable('x-powered-by');
// Render runs the app behind one trusted reverse proxy. This allows Express
// and express-rate-limit to read the client IP from X-Forwarded-For safely.
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
const allowedOrigins = (env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim());
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('Origin not allowed by CORS.')); }, credentials: false }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));

const productRow = row => row && ({ id:row.id,name:row.name,description:row.description,price:row.price,category:row.category,sizes:JSON.parse(row.sizes_json),stock:row.stock,image:row.image,status:row.status });
const orderRow = row => row && ({ id:row.id,amount:row.amount,status:row.status,payment_method:row.payment_method,customer_name:row.customer_name,customer_email:row.customer_email,customer_phone:row.customer_phone,address:row.address,city:row.city,pincode:row.pincode,items:JSON.parse(row.items_json),created_at:row.created_at,utr:row.utr });
const listProducts = () => db.prepare('SELECT * FROM products ORDER BY created_at DESC').all().map(productRow);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const mfEnabled=()=>env.MERCH_FACTORY_AUTO_FULFILLMENT==='true';
function mfSkuEnvName(productId,size){return 'MF_SKU_'+String(productId).toUpperCase().replace(/[^A-Z0-9]+/g,'_')+'_'+String(size).toUpperCase().replace(/[^A-Z0-9]+/g,'_');}
async function merchFactoryRequest(route,options={}){const response=await fetch('https://www.merchfactory.in/api/v1'+route,{...options,headers:{'Authorization':`Bearer ${env.MF_API_KEY}`,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(65000)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||data.error?.code||`Merch Factory API returned HTTP ${response.status}`);return data.data??data;}
async function submitMerchFactoryOrder(orderId){
 if(!mfEnabled())return {submitted:false,reason:'disabled'};
 if(!env.MF_API_KEY)throw new Error('MERCH_FACTORY_AUTO_FULFILLMENT is on but MF_API_KEY is missing.');
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);if(!order)throw new Error('Store order not found.');
 if(order.payment_method==='upi'&&order.status!=='paid')return {submitted:false,reason:'payment_not_confirmed'};
 if(order.payment_method==='cod'&&order.status==='cancelled')return {submitted:false,reason:'cancelled'};
 if(order.mf_order_id)return {submitted:true,duplicate:true,mfOrderId:order.mf_order_id};
 if(order.mf_status==='submitting')return {submitted:false,reason:'submission_in_progress'};
 const items=JSON.parse(order.items_json).map(item=>{const key=mfSkuEnvName(item.productId,item.size);const sku=env[key];if(!sku)throw new Error(`Missing Merch Factory SKU mapping: ${key}`);return{sku,quantity:item.quantity};});
 db.prepare("UPDATE orders SET mf_status='submitting',mf_error=NULL WHERE id=?").run(orderId);
 try{
 const payload={order_ref:order.id,payment_method:order.payment_method==='cod'?'cod':'prepaid',order_value:Number((order.amount/100).toFixed(2)),courier:env.MF_DEFAULT_COURIER||'cheapest',customer:{name:order.customer_name,phone:order.customer_phone,email:order.customer_email||'orders@kineticgrooves.invalid',address1:order.address,address2:order.address2||'Landmark not provided',pincode:order.pincode},items};
 const result=await merchFactoryRequest('/orders',{method:'POST',body:JSON.stringify(payload)});
 if(!result.id)throw new Error('Merch Factory response did not include an order ID.');
 db.prepare("UPDATE orders SET mf_order_id=?,mf_status=?,mf_error=NULL WHERE id=?").run(result.id,result.status||'PLACED',orderId);
 console.log('[KG MERCH FACTORY] Order submitted',orderId,result.id);
 return {submitted:true,mfOrderId:result.id,status:result.status||'PLACED'};
 }catch(error){db.prepare("UPDATE orders SET mf_status='failed',mf_error=? WHERE id=?").run(String(error.message).slice(0,500),orderId);console.error('[KG MERCH FACTORY] Submission failed',orderId,error.message);throw error;}
}
async function sendPaidOrderEmail(orderId) {
  if (!env.RESEND_API_KEY || !env.ORDER_NOTIFICATION_EMAIL || !env.ORDER_NOTIFICATION_FROM) {
    console.warn('[KG ORDER EMAIL] Not configured; set RESEND_API_KEY, ORDER_NOTIFICATION_EMAIL and ORDER_NOTIFICATION_FROM.');
    return false;
  }
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order || order.status !== 'paid') return false;
  const now = new Date().toISOString();
  const claim = db.prepare("INSERT OR IGNORE INTO order_email_notifications(order_id,status,updated_at) VALUES(?,'sending',?)").run(orderId,now);
  if (!claim.changes) {
    const retry = db.prepare("UPDATE order_email_notifications SET status='sending',updated_at=? WHERE order_id=? AND status='failed'").run(now,orderId);
    if (!retry.changes) return false;
  }
  const items = JSON.parse(order.items_json);
  const amount = (order.amount/100).toFixed(2);
  const itemLines = items.map(i => `${i.name} — Size ${i.size} × ${i.quantity} — ₹${(i.unitPrice*i.quantity/100).toFixed(2)}`);
  const details = [
    `Order: ${order.id}`, `Payment: ${order.payment_method.toUpperCase()} (PAID)`,
    `Amount: ₹${amount}`, `Customer: ${order.customer_name}`, `Email: ${order.customer_email || 'Not provided'}`,
    `Phone: ${order.customer_phone}`, `Address: ${order.address}, ${order.city}, ${order.pincode}`,
    `Gateway order: ${order.gateway_order_id || 'N/A'}`, `UTR: ${order.utr || 'N/A'}`,
    `Placed: ${order.created_at}`, '', 'ITEMS:', ...itemLines
  ];
  const html = `<h2>New paid Kinetic Grooves order</h2><p><b>Order:</b> ${escapeHtml(order.id)}</p><p><b>Payment:</b> ${escapeHtml(order.payment_method.toUpperCase())} — PAID</p><p><b>Total:</b> ₹${amount}</p><h3>Customer</h3><p>${escapeHtml(order.customer_name)}<br>${escapeHtml(order.customer_email || 'No email')}<br>${escapeHtml(order.customer_phone)}<br>${escapeHtml(order.address)}, ${escapeHtml(order.city)}, ${escapeHtml(order.pincode)}</p><h3>Items</h3><ul>${items.map(i=>`<li>${escapeHtml(i.name)} — Size ${escapeHtml(i.size)} × ${i.quantity} — ₹${(i.unitPrice*i.quantity/100).toFixed(2)}</li>`).join('')}</ul><p><b>FamGateway order:</b> ${escapeHtml(order.gateway_order_id || 'N/A')}<br><b>UTR:</b> ${escapeHtml(order.utr || 'N/A')}<br><b>Placed:</b> ${escapeHtml(order.created_at)}</p>`;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:env.ORDER_NOTIFICATION_FROM,to:[env.ORDER_NOTIFICATION_EMAIL],subject:`Paid order ${order.id} — ₹${amount}`,text:details.join('\\n'),html}),
      signal:AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
    db.prepare("UPDATE order_email_notifications SET status='sent',updated_at=? WHERE order_id=?").run(new Date().toISOString(),orderId);
    console.log('[KG ORDER EMAIL] Sent paid order notification',orderId);
    return true;
  } catch (error) {
    db.prepare("UPDATE order_email_notifications SET status='failed',updated_at=? WHERE order_id=?").run(new Date().toISOString(),orderId);
    console.error('[KG ORDER EMAIL] Failed to send',orderId,error.message);
    return false;
  }
}

const paymentProvider = String(env.PAYMENT_PROVIDER || 'famgateway').toLowerCase();
const activePaymentReady = paymentProvider === 'cashfree' ? Boolean(env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET) : paymentProvider === 'famgateway' ? env.FAMGATEWAY_ENABLED === 'true' && Boolean(env.FAMGATEWAY_API_KEY) : false;
const cashfreeBase = String(env.CASHFREE_ENV || 'SANDBOX').toUpperCase() === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
async function cashfreeRequest(route, options={}) {
  const response = await fetch(`${cashfreeBase}${route}`, { ...options, headers:{'Content-Type':'application/json','x-api-version':env.CASHFREE_API_VERSION || '2025-01-01','x-client-id':env.CASHFREE_CLIENT_ID,'x-client-secret':env.CASHFREE_CLIENT_SECRET,...(options.headers||{})}, signal:AbortSignal.timeout(15000) });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.message || data.type || `Cashfree API returned HTTP ${response.status}`);
  return data;
}
app.get('/api/health', (_req,res)=>res.json({ok:true,paymentsEnabled:activePaymentReady,codEnabled:env.COD_ENABLED==='true',paymentProvider:paymentProvider==='cashfree'?'cashfree':'upi'}));
app.get('/api/products', (_req,res)=>res.json({products:listProducts()}));

// Dev Mode auth: short-lived signed bearer token, kept in the browser's memory only.
function safeEqual(a,b){const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);}
function signToken(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');const sig=crypto.createHmac('sha256',env.SESSION_SECRET).update(body).digest('base64url');return `${body}.${sig}`;}
function verifyToken(token){try{const [body,sig]=String(token||'').split('.');if(!body||!sig)return false;const expected=crypto.createHmac('sha256',env.SESSION_SECRET).update(body).digest('base64url');if(!safeEqual(sig,expected))return false;const payload=JSON.parse(Buffer.from(body,'base64url').toString());return payload.exp>Date.now();}catch{return false;}}
function requireAdmin(req,res,next){const token=(req.get('Authorization')||'').replace(/^Bearer\s+/i,'');if(!env.SESSION_SECRET||!verifyToken(token))return res.status(401).json({error:'Dev Mode session expired. Sign in again.'});next();}
const loginLimiter=rateLimit({windowMs:15*60_000,limit:8,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Too many login attempts. Try again later.'}});
app.post('/api/admin/login',loginLimiter,(req,res)=>{if(!env.DEV_MODE_PASSWORD||!env.SESSION_SECRET)return res.status(503).json({error:'Dev Mode is not configured on the server.'});if(!safeEqual(req.body?.password||'',env.DEV_MODE_PASSWORD))return res.status(401).json({error:'Incorrect password.'});const token=signToken({role:'admin',exp:Date.now()+8*60*60*1000});res.json({token,expiresIn:28800});});
app.get('/api/admin/products',requireAdmin,(_req,res)=>res.json({products:listProducts()}));
app.post('/api/admin/products',requireAdmin,(req,res)=>{try{const p=normalizeProduct(req.body);const now=new Date().toISOString();db.prepare(`INSERT INTO products(id,name,description,price,category,sizes_json,stock,image,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.name,p.description,p.price,p.category,JSON.stringify(p.sizes),p.stock,p.image,p.status,now,now);res.status(201).json({product:productRow(db.prepare('SELECT * FROM products WHERE id=?').get(p.id))});}catch(e){res.status(400).json({error:e.message});}});
app.put('/api/admin/products/:id',requireAdmin,(req,res)=>{try{const p=normalizeProduct(req.body,req.params.id);const result=db.prepare(`UPDATE products SET name=?,description=?,price=?,category=?,sizes_json=?,stock=?,image=?,status=?,updated_at=? WHERE id=?`).run(p.name,p.description,p.price,p.category,JSON.stringify(p.sizes),p.stock,p.image,p.status,new Date().toISOString(),req.params.id);if(!result.changes)return res.status(404).json({error:'Product not found.'});res.json({product:productRow(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id))});}catch(e){res.status(400).json({error:e.message});}});
app.delete('/api/admin/products/:id',requireAdmin,(req,res)=>{const result=db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);if(!result.changes)return res.status(404).json({error:'Product not found.'});res.json({ok:true});});
function normalizeProduct(input,id){const name=String(input.name||'').trim();const price=Number(input.price);const stock=Number(input.stock||0);const sizes=Array.isArray(input.sizes)?input.sizes.map(x=>String(x).trim().toUpperCase()).filter(Boolean):[];const category=String(input.category||'Tees');const status=['active','draft','archived'].includes(input.status)?input.status:'draft';if(!name)throw new Error('Product name is required.');if(!Number.isSafeInteger(price)||price<1)throw new Error('Price must be a positive integer in paise.');if(!Number.isInteger(stock)||stock<0)throw new Error('Stock must be a non-negative whole number.');if(!['Tees','Hoodies','Cargos','Accessories'].includes(category))throw new Error('Choose a valid category.');if(!sizes.length)throw new Error('Add at least one size or option.');return{id:id||crypto.randomUUID(),name,description:String(input.description||'').slice(0,2000),price,category,sizes,stock,image:String(input.image||'').slice(0,1000),status};}
const storage=multer.diskStorage({destination:(_req,_file,cb)=>cb(null,uploadDir),filename:(_req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,`${crypto.randomUUID()}${ext}`);}});
const upload=multer({storage,limits:{fileSize:5*1024*1024},fileFilter:(_req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))});
app.post('/api/admin/upload',requireAdmin,(req,res)=>upload.single('image')(req,res,err=>{if(err)return res.status(400).json({error:err.message||'Image upload failed.'});if(!req.file)return res.status(400).json({error:'Choose a PNG, JPG or WebP image.'});res.status(201).json({url:`/uploads/${req.file.filename}`});}));
app.get('/api/admin/orders',requireAdmin,(_req,res)=>res.json({orders:db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all().map(orderRow)}));
app.patch('/api/admin/orders/:id',requireAdmin,(req,res)=>{const allowed=['pending','paid','confirmed','packed','shipped','delivered','cancelled'];if(!allowed.includes(req.body?.status))return res.status(400).json({error:'Invalid order status.'});const result=db.prepare('UPDATE orders SET status=? WHERE id=?').run(req.body.status,req.params.id);if(!result.changes)return res.status(404).json({error:'Order not found.'});res.json({ok:true});});

function calculateCart(items){if(!Array.isArray(items)||!items.length||items.length>20)throw new Error('Your cart is empty or invalid.');const normalized=items.map(item=>{const p=db.prepare('SELECT * FROM products WHERE id=?').get(item.productId);const qty=Number(item.quantity);if(!p||p.status!=='active')throw new Error('One of the selected products is not available.');if(!Number.isInteger(qty)||qty<1||qty>5||!JSON.parse(p.sizes_json).includes(item.size))throw new Error('A cart item is invalid.');if(p.stock<qty)throw new Error(`${p.name} does not have enough stock.`);return{productId:p.id,name:p.name,size:item.size,quantity:qty,unitPrice:p.price};});return{items:normalized,amount:normalized.reduce((s,x)=>s+x.unitPrice*x.quantity,0)};}
function validCustomer(c){const name=String(c?.name||'').trim(),phone=String(c?.phone||'').replace(/\D/g,'');const address=String(c?.address||'').trim(),city=String(c?.city||'').trim(),pincode=String(c?.pincode||'').trim();if(name.length<2||phone.length!==10||address.length<8||city.length<2||!/^[1-9][0-9]{5}$/.test(pincode))throw new Error('Enter a valid name, 10-digit mobile number and complete Indian delivery address.');return{name,phone,email:String(c.email||'').slice(0,160),address,city,pincode};}
app.post('/api/checkout',async(req,res)=>{try{const method=req.body?.paymentMethod;if(!['upi','cod'].includes(method))throw new Error('Choose a payment method.');if(method==='upi'&&!activePaymentReady)return res.status(503).json({error:`${paymentProvider} UPI checkout is not configured. Check PAYMENT_PROVIDER and its server credentials.`});if(method==='cod'&&env.COD_ENABLED!=='true')return res.status(503).json({error:'Cash on Delivery is not enabled yet.'});const customer=validCustomer(req.body.customer);const address2=String(req.body.customer?.address2||'').trim();if(address2.length<2)throw new Error('Enter a nearby landmark for delivery.');const{items,amount}=calculateCart(req.body.items);const id=`KG-${crypto.randomUUID()}`;let gatewayOrderId=null,checkoutUrl=null,paymentSessionId=null;
if(method==='upi'){const base=String(env.PUBLIC_BASE_URL||'').replace(/\/$/,'');if(!base.startsWith('https://'))return res.status(503).json({error:'A public HTTPS backend URL is required before enabling live payments.'});if(paymentProvider==='cashfree'){const cf=await cashfreeRequest('/orders',{method:'POST',body:JSON.stringify({order_id:id,order_amount:Number((amount/100).toFixed(2)),order_currency:'INR',customer_details:{customer_id:id.slice(0,50),customer_name:customer.name,customer_email:customer.email||undefined,customer_phone:customer.phone},order_meta:{return_url:`${env.STOREFRONT_URL||allowedOrigins[0]}/?order=${encodeURIComponent(id)}`,notify_url:`${base}/api/cashfree-webhook`}})});if(!cf.order_id||!cf.payment_session_id)throw new Error('Cashfree did not return an order ID and payment session.');gatewayOrderId=cf.order_id;paymentSessionId=cf.payment_session_id;}else{const gatewayResponse=await fetch('https://famgateway.in/api/create-order',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':env.FAMGATEWAY_API_KEY},body:JSON.stringify({amount:(amount/100).toFixed(2),customer_name:customer.name,customer_email:customer.email,customer_phone:customer.phone,redirect_url:`${env.STOREFRONT_URL||allowedOrigins[0]}/?order=${encodeURIComponent(id)}`,webhook_url:`${base}/api/famgateway-webhook`})});const raw=await gatewayResponse.json().catch(()=>({}));const g=raw.data||raw;if(!gatewayResponse.ok||raw.status==='error'||!g.order_id||!g.checkout_url)throw new Error(raw.message||'FamGateway could not create a payment session.');gatewayOrderId=g.order_id;checkoutUrl=g.checkout_url;}}
const now=new Date().toISOString();
const placeOrder=db.transaction(()=>{const dec=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?');for(const item of items){const r=dec.run(item.quantity,item.productId,item.quantity);if(!r.changes)throw new Error('Inventory changed during checkout. Please refresh your cart.');}db.prepare(`INSERT INTO orders(id,gateway_order_id,amount,status,payment_method,customer_name,customer_email,customer_phone,address,city,pincode,items_json,created_at,payment_provider,address2) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,gatewayOrderId,amount,method==='cod'?'pending':'awaiting_payment',method,customer.name,customer.email,customer.phone,customer.address,customer.city,customer.pincode,JSON.stringify(items),now,method==='upi'?paymentProvider:'none',address2);});
placeOrder();
if(method==='cod'&&mfEnabled())try{await submitMerchFactoryOrder(id);}catch(error){console.error('[KG MF COD ORDER NEEDS RETRY]',id,error.message);}res.status(201).json({orderId:id,checkoutUrl,paymentSessionId:paymentSessionId,cashfreeMode:paymentProvider==='cashfree'?(String(env.CASHFREE_ENV||'SANDBOX').toUpperCase()==='PRODUCTION'?'production':'sandbox'):null,amount,paymentMethod:method});}catch(e){res.status(400).json({error:e.message||'Unable to place order.'});}});

// FamGateway HMAC-SHA256 webhook: verify raw request bytes before updating an order.
app.post('/api/famgateway-webhook',async(req,res)=>{const key=env.FAMGATEWAY_API_KEY;const signature=req.get('X-FamGateway-Signature')||'';if(!key||!req.rawBody||!/^[a-f0-9]{64}$/i.test(signature))return res.status(401).send('Unauthorized');const expected=crypto.createHmac('sha256',key).update(req.rawBody).digest();const supplied=Buffer.from(signature,'hex');if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return res.status(401).send('Invalid signature');const event=req.body||{};if(event.event==='payment.success'||event.status==='success'){const row=db.prepare('SELECT * FROM orders WHERE gateway_order_id=?').get(event.order_id);const received=Math.round(Number(event.amount)*100);if(row&&received===row.amount){const updated=db.prepare("UPDATE orders SET status='paid',utr=? WHERE gateway_order_id=? AND status IN ('awaiting_payment','pending')").run(String(event.utr||''),event.order_id);if(updated.changes){await sendPaidOrderEmail(row.id);if(mfEnabled())try{await submitMerchFactoryOrder(row.id);}catch(error){console.error('[KG MF FOLLOWUP REQUIRED]',row.id,error.message);}}}}res.status(200).send('OK');});
app.post('/api/cashfree-webhook',async(req,res)=>{const signature=req.get('x-webhook-signature')||'';const timestamp=req.get('x-webhook-timestamp')||'';if(!env.CASHFREE_CLIENT_SECRET||!req.rawBody||!signature||!timestamp)return res.status(401).send('Unauthorized');const expected=crypto.createHmac('sha256',env.CASHFREE_CLIENT_SECRET).update(timestamp+req.rawBody.toString('utf8')).digest('base64');if(!safeEqual(signature,expected))return res.status(401).send('Invalid signature');const event=req.body||{};const orderId=event?.data?.order?.order_id;const payment=event?.data?.payment;if(orderId&&payment?.payment_status==='SUCCESS'){const row=db.prepare("SELECT * FROM orders WHERE gateway_order_id=? AND payment_provider='cashfree'").get(orderId);const paidAmount=Number(payment.payment_amount);if(row&&Math.round(paidAmount*100)===row.amount){const updated=db.prepare("UPDATE orders SET status='paid',utr=? WHERE id=? AND status='awaiting_payment'").run(String(payment.cf_payment_id||''),row.id);if(updated.changes){await sendPaidOrderEmail(row.id);if(mfEnabled())try{await submitMerchFactoryOrder(row.id);}catch(error){console.error('[KG MF FOLLOWUP REQUIRED]',row.id,error.message);}}}}res.status(200).send('OK');});
app.post('/api/merch-factory/webhook',async(req,res)=>{try{const secret=env.MF_WEBHOOK_SECRET;const header=req.get('MF-Signature')||'';const parts=Object.fromEntries(header.split(',').map(p=>p.split('=')));const timestamp=Number(parts.t);const signature=String(parts.v1||'');const fresh=Number.isFinite(timestamp)&&Math.abs(Date.now()/1000-timestamp)<300;if(!secret||!req.rawBody||!fresh||!/^[a-f0-9]{64}$/i.test(signature))return res.sendStatus(401);const expected=crypto.createHmac('sha256',secret).update(String(parts.t)+'.'+req.rawBody.toString()).digest('hex');if(!safeEqual(expected,signature))return res.sendStatus(401);const event=req.body||{};const eventId=String(event.id||req.get('MF-Event-Id')||'');if(!eventId)return res.sendStatus(400);const claim=db.prepare('INSERT OR IGNORE INTO merch_factory_webhook_events(event_id,received_at) VALUES(?,?)').run(eventId,new Date().toISOString());if(!claim.changes)return res.sendStatus(200);const mfOrder=event.data?.order;if(mfOrder?.order_ref){db.prepare('UPDATE orders SET mf_status=?,mf_order_id=COALESCE(mf_order_id,?) WHERE id=?').run(String(mfOrder.status||event.type),String(mfOrder.id||''),String(mfOrder.order_ref));}return res.sendStatus(200);}catch(error){console.error('[KG MF WEBHOOK]',error.message);return res.sendStatus(500);}});
app.get('/api/orders/:id/status',async(req,res)=>{const row=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({error:'Order not found.'});if(row.payment_method==='upi'&&row.status==='awaiting_payment'&&row.gateway_order_id){try{if(row.payment_provider==='cashfree'){const order=await cashfreeRequest('/orders/'+encodeURIComponent(row.gateway_order_id),{method:'GET'});if(order.order_status==='PAID'&&Math.round(Number(order.order_amount)*100)===row.amount){const paidUpdate=db.prepare("UPDATE orders SET status='paid' WHERE id=? AND status='awaiting_payment'").run(row.id);row.status='paid';if(paidUpdate.changes)await sendPaidOrderEmail(row.id);}else if(order.order_status==='EXPIRED'){db.prepare("UPDATE orders SET status='expired' WHERE id=? AND status='awaiting_payment'").run(row.id);row.status='expired';}}else{if(!env.FAMGATEWAY_API_KEY)throw new Error('FamGateway is not configured.');const u=new URL('https://famgateway.in/api/verify-order.php');u.searchParams.set('api_key',env.FAMGATEWAY_API_KEY);u.searchParams.set('order_id',row.gateway_order_id);const r=await fetch(u,{headers:{'Accept':'application/json'},signal:AbortSignal.timeout(10000)});const raw=await r.json();const d=raw.data||raw;if(!r.ok||raw.status==='error')throw new Error('FamGateway verification request failed.');if(d.status==='success'){const verifiedId=String(d.order_id||'');const verifiedAmount=Math.round(Number(d.amount)*100);if(verifiedId!==row.gateway_order_id||!Number.isFinite(verifiedAmount)||verifiedAmount!==row.amount)throw new Error('FamGateway verification details did not match this order.');const updated=db.prepare("UPDATE orders SET status='paid',utr=? WHERE id=? AND status='awaiting_payment'").run(String(d.utr||''),row.id);row.status='paid';row.utr=d.utr||'';if(updated.changes)await sendPaidOrderEmail(row.id);}else if(d.status==='expired'){db.prepare("UPDATE orders SET status='expired' WHERE id=? AND status='awaiting_payment'").run(row.id);row.status='expired';}}}catch(e){console.error('[KG PAYMENT VERIFY]',e.message);return res.status(503).json({error:'Payment verification is temporarily unavailable. Please retry shortly.'});}}
res.json({orderId:row.id,status:row.status,amount:row.amount,paymentMethod:row.payment_method,fulfillment:{provider:'merch_factory',status:row.mf_status||'not_submitted',orderId:row.mf_order_id||null}});});

if(env.NODE_ENV==='production'){const dist=path.join(root,'dist');app.use(express.static(dist));app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API route not found.'});res.sendFile(path.join(dist,'index.html'));});}
app.use((err,req,res,_next)=>{
  // Log the real exception in Render so production failures are diagnosable.
  console.error('[KG API ERROR]', {
    method: req.method,
    path: req.originalUrl,
    message: err?.message || String(err),
    stack: err?.stack || null
  });
  if (res.headersSent) return;
  res.status(500).json({error:'Unexpected server error.'});
});
const port=Number(env.PORT||4000);app.listen(port,()=>console.log(`Kinetic Grooves API listening on ${port}`));
