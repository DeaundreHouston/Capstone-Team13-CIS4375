import mysql from "mysql2/promise";
import Stripe from "stripe"; // 1. Import Stripe

// 2. Initialize Stripe with your Secret Key from Environment Variables
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* =========================
   CONFIG & POOL
========================= */
const CORS = {
  "Access-Control-Allow-Origin": "*", 
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PATCH,DELETE",
};

const TAX_RATE = 0.0825; // Matching your frontend tax rate

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

/* =========================
   RESPONSE HELPERS
========================= */
function response(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}
const ok = (body) => response(200, body);
const created = (body) => response(201, body);
const badRequest = (msg) => response(400, { error: msg });
const notFound = (msg = "Not found") => response(404, { error: msg });
const serverError = (err) => {
    console.error("CRITICAL ERROR:", err);
    return response(500, { error: "Server Error", detail: err.message || String(err) });
};

function parseJsonBody(event) {
  if (!event?.body) return null;
  try { return JSON.parse(event.body); } catch { return null; }
}

async function withTx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e; 
  } finally {
    conn.release();
  }
}

/* ... (Keep Owner and Staff routes as they were) ... */

/* =========================
   ORDER CREATION (THE SECURE PATH)
========================= */
async function routeCreateOrder(event) {
  const body = parseJsonBody(event);
  if (!body || !body.paymentMethodId) return badRequest("Invalid Order or Missing Payment Method");
  
  const customer = body.customer || {};
  const items = body.items || [];
  const conn = getPool();

  try {
    // 3. SECURE PRICE LOOKUP: Get real prices from the DB
    const productIds = items.map(i => i.product_id);
    const [dbProducts] = await conn.query(
      `SELECT Product_ID, Price FROM Product WHERE Product_ID IN (?)`, 
      [productIds]
    );

    // Create a map for quick lookup
    const priceMap = {};
    dbProducts.forEach(p => { priceMap[p.Product_ID] = Number(p.Price); });

    // 4. CALCULATE TOTAL (In Backend)
    let subtotal = 0;
    const validatedItems = items.map(it => {
      const price = priceMap[it.product_id];
      subtotal += price * it.qty;
      return { ...it, unit_price: price };
    });

    const totalWithTax = subtotal * (1 + TAX_RATE);
    const amountInCents = Math.round(totalWithTax * 100); // Stripe expects cents

    // 5. STRIPE CHARGE
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      payment_method: body.paymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      description: `Order for ${customer.email}`
    });

    if (paymentIntent.status !== 'succeeded') {
      return badRequest("Payment failed to process.");
    }

    // 6. DB TRANSACTION (Only happens if payment succeeded)
    return await withTx(async (tx) => {
      const email = customer.email;
      
      let [found] = await tx.execute(`SELECT Customer_ID FROM Customer WHERE Email = ? LIMIT 1`, [email]);
      let customerId;
      
      if (found.length > 0) {
        customerId = found[0].Customer_ID;
      } else {
        const [ins] = await tx.execute(
          `INSERT INTO Customer (First_name, Last_name, Email, Address, Phone) VALUES (?, ?, ?, ?, ?)`,
          [customer.first_name, customer.last_name, email, customer.address, customer.phone]
        );
        customerId = ins.insertId;
      }

      const [orderIns] = await tx.execute(
        `INSERT INTO orders (Customer_id, status, Order_date, Total_amount) VALUES (?, 'Pending', NOW(), ?)`,
        [customerId, totalWithTax]
      );
      const newOrderId = orderIns.insertId; 
      
      for (const it of validatedItems) {
        await tx.execute(
          `INSERT INTO ProductOrder (Order_ID, Product_ID, Quantity, unit_price) VALUES (?, ?, ?, ?)`,
          [newOrderId, it.product_id, it.qty, it.unit_price]
        );
      }
      
      return created({ orderId: newOrderId, stripeId: paymentIntent.id });
    });

  } catch (err) {
    if (err.type === 'StripeCardError') return badRequest(err.message);
    return serverError(err);
  }
}

/* =========================
   HANDLER
========================= */
export const handler = async (event) => {
  try {
    // 1. These lines MUST be here to define the request details
    const method = event.httpMethod || event.requestContext?.http?.method || "GET";
    const path = event.path || event.rawPath || "/";
    const resource = event.resource || "";

    // 2. Handle the Pre-flight request for CORS
    if (method === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

    // --- OWNER ROUTES ---
    if (method === "GET" && path.includes("/owner/metrics/revenue")) return await routeOwnerRevenue();

    // --- STAFF ROUTES ---
    if (method === "GET" && path.startsWith("/staff/orders")) return await routeStaffGetOrders(event);
    if (method === "PATCH" && resource.includes("/status")) return await routeStaffUpdateStatus(event);

    // --- PRODUCT ROUTES ---
    if (method === "GET" && (path === "/products" || resource === "/products")) return await routeGetAllProducts();
    if (method === "PATCH" && (resource === "/products/{id}" || path.startsWith("/products/"))) return await routeUpdateProduct(event);

    // --- ORDER ROUTES (THE SECURE FLOW) ---
    if (method === "POST" && (path === "/orders" || resource === "/orders")) {
      return await routeCreateOrder(event);
    }

    return notFound(`Not Found: ${method} ${path}`);
  } catch (err) {
    return serverError(err);
  }
};