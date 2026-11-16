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
`);
const initialProducts = JSON.parse(fs.readFileSync(path.join(root, 'shared/products.json'), 'utf8'));
const insertSeed = db.prepare(`INSERT OR IGNORE INTO products (id,name,description,price,category,sizes_json,stock,image,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
for (const p of initialProducts) insertSeed.run(p.id,p.name,p.description,p.price,p.category,JSON.stringify(p.sizes || ['S','M','L','XL']),0,p.image || '', 'draft',new Date().toISOString(),new Date().toISOString());

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
const allowedOrigins = (env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim());
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); cb(new Error('Origin not allowed by CORS.')); }, credentials: false }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));

const productRow = row => row && ({ id:row.id,name:row.name,description:row.description,price:row.price,category:row.category,sizes:JSON.parse(row.sizes_json),stock:row.stock,image:row.image,status:row.status });
const orderRow = row => row && ({ id:row.id,amount:row.amount,status:row.status,payment_method:row.payment_method,customer_name:row.customer_name,customer_email:row.customer_email,customer_phone:row.customer_phone,address:row.address,city:row.city,pincode:row.pincode,items:JSON.parse(row.items_json),created_at:row.created_at,utr:row.utr });
const listProducts = () => db.prepare('SELECT * FROM products ORDER BY created_at DESC').all().map(productRow);
app.get('/api/health', (_req,res)=>res.json({ok:true,paymentsEnabled:env.FAMGATEWAY_ENABLED==='true',codEnabled:env.COD_ENABLED==='true'}));
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
app.post('/api/checkout',async(req,res)=>{try{const method=req.body?.paymentMethod;if(!['upi','cod'].includes(method))throw new Error('Choose a payment method.');if(method==='upi'&&(env.FAMGATEWAY_ENABLED!=='true'||!env.FAMGATEWAY_API_KEY))return res.status(503).json({error:'UPI checkout is not enabled. Configure and verify the merchant account first.'});if(method==='cod'&&env.COD_ENABLED!=='true')return res.status(503).json({error:'Cash on Delivery is not enabled yet.'});const customer=validCustomer(req.body.customer);const{items,amount}=calculateCart(req.body.items);const id=`KG-${crypto.randomUUID()}`;let gatewayOrderId=null,checkoutUrl=null;
if(method==='upi'){const base=String(env.PUBLIC_BASE_URL||'').replace(/\/$/,'');if(!base.startsWith('https://'))return res.status(503).json({error:'A public HTTPS backend URL is required before enabling live payments.'});const gatewayResponse=await fetch('https://famgateway.in/api/create-order',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':env.FAMGATEWAY_API_KEY},body:JSON.stringify({amount:(amount/100).toFixed(2),customer_name:customer.name,customer_email:customer.email,customer_phone:customer.phone,redirect_url:`${env.STOREFRONT_URL||allowedOrigins[0]}/?order=${encodeURIComponent(id)}`,webhook_url:`${base}/api/famgateway-webhook`})});const raw=await gatewayResponse.json().catch(()=>({}));const g=raw.data||raw;if(!gatewayResponse.ok||raw.status==='error'||!g.order_id||!g.checkout_url)throw new Error(raw.message||'FamGateway could not create a payment session.');gatewayOrderId=g.order_id;checkoutUrl=g.checkout_url;}
const now=new Date().toISOString();
const placeOrder=db.transaction(()=>{const dec=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?');for(const item of items){const r=dec.run(item.quantity,item.productId,item.quantity);if(!r.changes)throw new Error('Inventory changed during checkout. Please refresh your cart.');}db.prepare(`INSERT INTO orders(id,gateway_order_id,amount,status,payment_method,customer_name,customer_email,customer_phone,address,city,pincode,items_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,gatewayOrderId,amount,method==='cod'?'pending':'awaiting_payment',method,customer.name,customer.email,customer.phone,customer.address,customer.city,customer.pincode,JSON.stringify(items),now);});
placeOrder();
res.status(201).json({orderId:id,checkoutUrl,amount,paymentMethod:method});}catch(e){res.status(400).json({error:e.message||'Unable to place order.'});}});

// FamGateway HMAC-SHA256 webhook: verify raw request bytes before updating an order.
app.post('/api/famgateway-webhook',(req,res)=>{const key=env.FAMGATEWAY_API_KEY;const signature=req.get('X-FamGateway-Signature')||'';if(!key||!req.rawBody||!/^[a-f0-9]{64}$/i.test(signature))return res.status(401).send('Unauthorized');const expected=crypto.createHmac('sha256',key).update(req.rawBody).digest();const supplied=Buffer.from(signature,'hex');if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return res.status(401).send('Invalid signature');const event=req.body||{};if(event.event==='payment.success'||event.status==='success'){const row=db.prepare('SELECT * FROM orders WHERE gateway_order_id=?').get(event.order_id);const received=Math.round(Number(event.amount)*100);if(row&&received===row.amount){db.prepare("UPDATE orders SET status='paid',utr=? WHERE gateway_order_id=? AND status IN ('awaiting_payment','pending')").run(String(event.utr||''),event.order_id);}}res.status(200).send('OK');});
app.get('/api/orders/:id/status',async(req,res)=>{const row=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({error:'Order not found.'});if(row.payment_method==='upi'&&row.status==='awaiting_payment'&&row.gateway_order_id){try{const u=new URL('https://famgateway.in/api/checkout-status.php');u.searchParams.set('order_id',row.gateway_order_id);const r=await fetch(u);const d=await r.json();if(d.status==='success'){db.prepare("UPDATE orders SET status='paid',utr=? WHERE id=?").run(String(d.utr||''),row.id);row.status='paid';row.utr=d.utr||'';}else if(d.status==='expired'){db.prepare("UPDATE orders SET status='expired' WHERE id=?").run(row.id);row.status='expired';}}catch{}}
res.json({orderId:row.id,status:row.status,amount:row.amount,paymentMethod:row.payment_method});});

if(env.NODE_ENV==='production'){const dist=path.join(root,'dist');app.use(express.static(dist));app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API route not found.'});res.sendFile(path.join(dist,'index.html'));});}
app.use((err,_req,res,_next)=>{res.status(500).json({error:'Unexpected server error.'});});
const port=Number(env.PORT||4000);app.listen(port,()=>console.log(`Kinetic Grooves API listening on ${port}`));
