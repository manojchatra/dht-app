require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('etag', false);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'dht-app-secret-2026',
  resave:            false,
  saveUninitialized: false,
  cookie: { maxAge: 6 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/img', express.static(path.join(__dirname, 'public/img')));

// DB init
require('./db/database');

const { requireAuth } = require('./middleware/auth');

// Auth (public)
app.use('/auth', require('./routes/auth'));

// Protected API routes
app.use('/api/contracts',    requireAuth, require('./routes/contracts'));
app.use('/api/notifications', requireAuth, require('./routes/notifications'));
app.use('/api/inventory',    requireAuth, require('./routes/inventory'));
app.use('/api/users',        requireAuth, require('./routes/users'));
app.use('/api/payments',     requireAuth, require('./routes/payments'));
app.use('/api/settings',     requireAuth, require('./routes/settings-api'));
app.use('/api/delivery',     requireAuth, require('./routes/delivery'));
app.use('/api/post-delivery', requireAuth, require('./routes/post-delivery'));
app.get('/api/activity/:contractId', requireAuth, (req,res) => {
  const db = require('./db/database');
  try {
    const logs = db.prepare('SELECT * FROM activity_log WHERE contract_id=? ORDER BY id DESC LIMIT 50').all(req.params.contractId);
    res.json(logs);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Delivery team pages (served server-side, require delivery/admin role)
app.get('/delivery/:id',      requireAuth, (req,res) => res.sendFile(path.join(__dirname,'../web/app.deserthottubsaz.com/public_html/delivery-view.html')));
app.get('/acknowledgement', requireAuth, (req,res) => res.sendFile(path.join(__dirname,'../web/app.deserthottubsaz.com/public_html/acknowledgement-hub.html')));
app.get('/acknowledgement/:id', requireAuth, (req,res) => res.sendFile(path.join(__dirname,'../web/app.deserthottubsaz.com/public_html/acknowledgement.html')));
app.get('/post-delivery',        requireAuth, (req,res) => res.sendFile(path.join(__dirname,'../web/app.deserthottubsaz.com/public_html/post-delivery-hub.html')));
app.get('/post-delivery/admin',  requireAuth, (req,res) => res.sendFile(path.join(__dirname,'../web/app.deserthottubsaz.com/public_html/post-delivery-admin.html')));
app.get('/post-delivery/:id',    requireAuth, (req,res) => res.sendFile(path.join(__dirname,'../web/app.deserthottubsaz.com/public_html/post-delivery.html')));

// Page routes
const serve = file => (req, res) =>
  res.sendFile(file, { root: path.join(__dirname, '../web/app.deserthottubsaz.com/public_html') });

app.get('/login',                  serve('login.html'));
app.get('/',          requireAuth, serve('dashboard.html'));
app.get('/dashboard', requireAuth, serve('dashboard.html'));
app.get('/contracts', requireAuth, serve('view-contracts.html'));
app.get('/contracts/new',  requireAuth, serve('create-contract.html'));
app.get('/contracts/view',  requireAuth, serve('view-contracts.html'));
app.get('/contracts/preview', requireAuth, serve('preview-contract.html'));
app.get('/contracts/:id',  requireAuth, serve('contract-detail.html'));
app.get('/status',    requireAuth, serve('status.html'));
app.get('/calendar',  requireAuth, serve('calendar.html'));
app.get('/settings',  requireAuth, serve('settings.html'));

// Unbuilt pages
['calendar','pre-delivery-checklist'].forEach(slug => {
  app.get(`/${slug}`, requireAuth, (req, res) => res.redirect('/?coming-soon=' + slug));
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, '127.0.0.1', () => console.log(`DHT App running on port ${PORT}`));
