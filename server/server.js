import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import connectDB from './config/db.js';
import { User, Food, Category, Order, Review } from './models/index.js';
import { protect, adminOnly } from './middleware/auth.js';
import { localCatalog } from './localCatalog.js';

const app = express();
app.use(helmet()); app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' })); app.use(express.json({ limit: '1mb' })); app.use(morgan('dev'));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const tokenFor = user => jwt.sign({ id: user._id }, process.env.JWT_SECRET || localCatalog.jwtSecret, { expiresIn: '7d' });
const publicUser = u => ({ id: u._id, name: u.name, email: u.email, role: u.role, phone: u.phone, avatar: u.avatar, addresses: u.addresses, favorites: u.favorites });
const validId = (id) => mongoose.isValidObjectId(id);
const cleanString = (v, max = 1000) => typeof v === 'string' ? v.trim().slice(0, max) : '';

app.get('/api/health', (req, res) => res.json({ status: 'ok', database: process.env.MONGO_URI ? (mongoose.connection.readyState === 1 ? 'connected' : 'disconnected') : 'local SQLite' }));
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = cleanString(req.body.name, 80), email = cleanString(req.body.email, 254).toLowerCase(), password = req.body.password;
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 8) return res.status(400).json({ message: 'Enter a name, valid email, and password of at least 8 characters.' });
  if (!process.env.MONGO_URI) {
    if (localCatalog.users.findByEmail(email)) return res.status(409).json({ message: 'An account with that email already exists.' });
    const user = await localCatalog.users.create({ name, email, password });
    return res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
  }
  if (await User.exists({ email })) return res.status(409).json({ message: 'An account with that email already exists.' });
  const user = await User.create({ name, email, password }); res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = cleanString(req.body.email, 254).toLowerCase(); const password = req.body.password;
  if (!process.env.MONGO_URI) {
    const user = typeof password === 'string' ? await localCatalog.users.verify(email, password) : null;
    if (!user) return res.status(401).json({ message: 'Invalid email or password.' });
    return res.json({ token: tokenFor(user), user: publicUser(user) });
  }
  const user = await User.findOne({ email }).select('+password');
  if (!user || user.disabled || typeof password !== 'string' || !(await user.comparePassword(password))) return res.status(401).json({ message: 'Invalid email or password.' });
  res.json({ token: tokenFor(user), user: publicUser(user) });
}));
app.get('/api/auth/me', protect, (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/logout', protect, (req, res) => res.json({ message: 'Signed out successfully.' }));

app.get('/api/categories', asyncRoute(async (req, res) => res.json(process.env.MONGO_URI ? await Category.find().sort('name') : localCatalog.categories())));
const foodQuery = req => {
  const q = {};
  if (req.query.category) q.category = validId(req.query.category) ? req.query.category : undefined;
  if (req.query.veg === 'true') q.isVeg = true;
  if (req.query.veg === 'false') q.isVeg = false;
  if (req.query.available !== 'false') q.available = true;
  if (req.query.maxPrice && Number.isFinite(+req.query.maxPrice)) q.price = { $lte: Math.max(0, +req.query.maxPrice) };
  if (req.query.minRating && Number.isFinite(+req.query.minRating)) q.rating = { $gte: Math.min(5, Math.max(0, +req.query.minRating)) };
  if (req.query.search) { const search = cleanString(req.query.search, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); q.$or = [{ name: new RegExp(search, 'i') }, { description: new RegExp(search, 'i') }, { tags: new RegExp(search, 'i') }]; }
  return q;
};
app.get('/api/foods', asyncRoute(async (req, res) => {
  if (!process.env.MONGO_URI) return res.json(localCatalog.foods(new URLSearchParams(req.query)));
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(48, Math.max(1, parseInt(req.query.limit) || 12));
  const sortMap = { popular: { popularity: -1, rating: -1 }, price_asc: { price: 1 }, price_desc: { price: -1 }, rating: { rating: -1 }, newest: { createdAt: -1 } };
  const query = foodQuery(req);
  if (req.query.search) {
    const categoryPattern = cleanString(req.query.search, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchingCategories = await Category.find({ name: new RegExp(categoryPattern, 'i') }).select('_id');
    if (matchingCategories.length) query.$or.push({ category: { $in: matchingCategories.map(c => c._id) } });
  }
  const [foods, total] = await Promise.all([Food.find(query).populate('category', 'name slug').sort(sortMap[req.query.sort] || sortMap.popular).skip((page - 1) * limit).limit(limit), Food.countDocuments(query)]);
  res.json({ foods, page, pages: Math.ceil(total / limit), total });
}));
app.get('/api/foods/:id', asyncRoute(async (req, res) => { if (!process.env.MONGO_URI) { const food = localCatalog.food(req.params.id); return food ? res.json(food) : res.status(404).json({ message: 'Food not found.' }); } if (!validId(req.params.id)) return res.status(404).json({ message: 'Food not found.' }); const food = await Food.findById(req.params.id).populate('category', 'name slug'); if (!food) return res.status(404).json({ message: 'Food not found.' }); res.json(food); }));
app.get('/api/foods/:id/reviews', asyncRoute(async (req, res) => { if (!process.env.MONGO_URI) return res.json([]); if (!validId(req.params.id)) return res.status(400).json({ message: 'Invalid food id.' }); const reviews = await Review.find({ food: req.params.id }).populate('user', 'name avatar').sort({ createdAt: -1 }); res.json(reviews); }));

app.get('/api/users/profile', protect, (req, res) => res.json({ user: publicUser(req.user) }));
app.put('/api/users/profile', protect, asyncRoute(async (req, res) => {
  const name = cleanString(req.body.name, 80), phone = cleanString(req.body.phone, 30);
  if (name.length < 2) return res.status(400).json({ message: 'Name must be at least 2 characters.' });
  req.user.name = name; req.user.phone = phone; await req.user.save(); res.json({ user: publicUser(req.user) });
}));
app.put('/api/users/password', protect, asyncRoute(async (req, res) => {
  if (typeof req.body.password !== 'string' || req.body.password.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters.' });
  req.user.password = req.body.password; await req.user.save(); res.json({ message: 'Password updated. Please sign in again.' });
}));
app.post('/api/users/addresses', protect, asyncRoute(async (req, res) => { const a = req.body; const pin = cleanString(a.postalCode, 10); if (!cleanString(a.line1, 160) || !cleanString(a.city, 80) || !/^[1-9][0-9]{5}$/.test(pin)) return res.status(400).json({ message: 'Enter a street, city, and valid 6-digit Indian PIN code.' }); req.user.addresses.push({ ...a, label: cleanString(a.label, 40) || 'Home', line1: cleanString(a.line1,160), city: cleanString(a.city,80), postalCode: pin }); await req.user.save(); res.status(201).json({ user: publicUser(req.user) }); }));
app.put('/api/users/addresses/:addressId', protect, asyncRoute(async (req, res) => { const a = req.user.addresses.id(req.params.addressId); if (!a) return res.status(404).json({ message: 'Address not found.' }); Object.assign(a, req.body); await req.user.save(); res.json({ user: publicUser(req.user) }); }));
app.delete('/api/users/addresses/:addressId', protect, asyncRoute(async (req, res) => { req.user.addresses.pull(req.params.addressId); await req.user.save(); res.json({ user: publicUser(req.user) }); }));

app.get('/api/favorites', protect, asyncRoute(async (req, res) => { await req.user.populate('favorites'); res.json(req.user.favorites); }));
app.post('/api/favorites/:foodId', protect, asyncRoute(async (req, res) => { if (!validId(req.params.foodId) || !await Food.exists({ _id: req.params.foodId })) return res.status(404).json({ message: 'Food not found.' }); if (!req.user.favorites.some(id => id.equals(req.params.foodId))) req.user.favorites.push(req.params.foodId); await req.user.save(); res.json({ favorites: req.user.favorites }); }));
app.delete('/api/favorites/:foodId', protect, asyncRoute(async (req, res) => { req.user.favorites.pull(req.params.foodId); await req.user.save(); res.json({ favorites: req.user.favorites }); }));

app.post('/api/orders', protect, asyncRoute(async (req, res) => {
  const { items, address } = req.body;
  if (!Array.isArray(items) || items.length < 1 || items.length > 40) return res.status(400).json({ message: 'Add items to your cart before checkout.' });
  if (!address?.line1 || !address?.city || !/^[1-9][0-9]{5}$/.test(String(address?.postalCode || ''))) return res.status(400).json({ message: 'A street, city, and valid 6-digit Indian PIN code are required.' });
  const ids = items.map(i => i.foodId); if (ids.some(id => !validId(id))) return res.status(400).json({ message: 'One or more cart items are invalid.' });
  const foods = await Food.find({ _id: { $in: ids }, available: true }); const byId = new Map(foods.map(f => [String(f._id), f]));
  const lines = items.map(i => { const f = byId.get(i.foodId); const qty = Math.max(1, Math.min(20, parseInt(i.quantity) || 1)); if (!f) throw Object.assign(new Error('One of these items is no longer available.'), { status: 400 }); const opt = f.options.find(o => o.name === i.option); const unitPrice = f.price + (opt?.price || 0); return { food: f._id, name: f.name, image: f.image, option: opt?.name || '', unitPrice, quantity: qty }; });
  const subtotal = lines.reduce((s, i) => s + i.unitPrice * i.quantity, 0), deliveryFee = subtotal >= 499 ? 0 : 39, tax = Math.round(subtotal * .05), discount = req.body.discount === 'BITE20' ? Math.min(150, Math.round(subtotal * .2)) : 0, total = Math.max(0, subtotal + tax + deliveryFee - discount);
  const order = await Order.create({ user: req.user._id, items: lines, address, subtotal, tax, deliveryFee, discount, total, paymentStatus: 'paid', paymentMethod: 'test', orderStatus: 'Confirmed' });
  await Food.bulkWrite(lines.map(i => ({ updateOne: { filter: { _id: i.food }, update: { $inc: { popularity: i.quantity } } } })));
  res.status(201).json({ order });
}));
app.get('/api/orders', protect, asyncRoute(async (req, res) => { res.json(await Order.find({ user: req.user._id }).sort({ createdAt: -1 })); }));
app.get('/api/orders/:id', protect, asyncRoute(async (req, res) => { if (!validId(req.params.id)) return res.status(404).json({ message: 'Order not found.' }); const filter = req.user.role === 'admin' ? { _id: req.params.id } : { _id: req.params.id, user: req.user._id }; const order = await Order.findOne(filter).populate('user', 'name email'); if (!order) return res.status(404).json({ message: 'Order not found.' }); res.json(order); }));
app.post('/api/foods/:foodId/reviews', protect, asyncRoute(async (req, res) => {
  const { rating, comment, orderId } = req.body; if (!Number.isInteger(+rating) || +rating < 1 || +rating > 5 || cleanString(comment, 1000).length < 2 || !validId(orderId)) return res.status(400).json({ message: 'Provide a rating, review, and valid order.' });
  const order = await Order.findOne({ _id: orderId, user: req.user._id, 'items.food': req.params.foodId, orderStatus: 'Delivered' }); if (!order) return res.status(403).json({ message: 'You can review this dish after its order is delivered.' });
  const review = await Review.create({ user: req.user._id, food: req.params.foodId, order: order._id, rating: +rating, comment: cleanString(comment, 1000) });
  const aggregate = await Review.aggregate([{ $match: { food: new mongoose.Types.ObjectId(req.params.foodId) } }, { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]); if (aggregate[0]) await Food.findByIdAndUpdate(req.params.foodId, { rating: Math.round(aggregate[0].avg * 10) / 10, reviewCount: aggregate[0].count });
  res.status(201).json(await review.populate('user', 'name avatar'));
}));

app.get('/api/admin/stats', protect, adminOnly, asyncRoute(async (req, res) => { const [users, orders, foods, pending, revenue] = await Promise.all([User.countDocuments(), Order.countDocuments(), Food.countDocuments(), Order.countDocuments({ orderStatus: { $in: ['Pending','Confirmed','Preparing'] } }), Order.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }])]); res.json({ users, orders, foods, pending, revenue: revenue[0]?.total || 0 }); }));
app.get('/api/admin/orders', protect, adminOnly, asyncRoute(async (req, res) => res.json(await Order.find().populate('user', 'name email').sort({ createdAt: -1 }).limit(100))));
app.patch('/api/admin/orders/:id/status', protect, adminOnly, asyncRoute(async (req, res) => { const allowed = ['Pending','Confirmed','Preparing','Out for delivery','Delivered','Cancelled']; if (!allowed.includes(req.body.orderStatus)) return res.status(400).json({ message: 'Invalid order status.' }); const order = await Order.findByIdAndUpdate(req.params.id, { orderStatus: req.body.orderStatus }, { new: true }); if (!order) return res.status(404).json({ message: 'Order not found.' }); res.json(order); }));
app.get('/api/admin/users', protect, adminOnly, asyncRoute(async (req, res) => res.json(await User.find().select('-password').sort({ createdAt: -1 }).limit(200))));
app.patch('/api/admin/users/:id', protect, adminOnly, asyncRoute(async (req, res) => { if (req.user.id === req.params.id && req.body.role === 'customer') return res.status(400).json({ message: 'You cannot remove your own admin access.' }); const update = {}; if (['customer','admin'].includes(req.body.role)) update.role = req.body.role; if (typeof req.body.disabled === 'boolean') update.disabled = req.body.disabled; const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select('-password'); if (!user) return res.status(404).json({ message: 'User not found.' }); res.json(user); }));
app.post('/api/admin/foods', protect, adminOnly, asyncRoute(async (req, res) => { const { name, description, price, image, category } = req.body; if (!cleanString(name,120) || !cleanString(description) || !validId(category) || !Number.isFinite(+price) || +price < 0 || !/^https?:\/\//.test(image || '')) return res.status(400).json({ message: 'Name, description, category, valid price, and image URL are required.' }); res.status(201).json(await Food.create({ ...req.body, name: cleanString(name,120), price: +price, isVeg: !!req.body.isVeg })); }));
app.put('/api/admin/foods/:id', protect, adminOnly, asyncRoute(async (req, res) => { const food = await Food.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }); if (!food) return res.status(404).json({ message: 'Food not found.' }); res.json(food); }));
app.delete('/api/admin/foods/:id', protect, adminOnly, asyncRoute(async (req, res) => { const food = await Food.findByIdAndDelete(req.params.id); if (!food) return res.status(404).json({ message: 'Food not found.' }); res.json({ message: 'Food deleted.' }); }));
app.post('/api/admin/categories', protect, adminOnly, asyncRoute(async (req, res) => { const name = cleanString(req.body.name,60); if (name.length < 2) return res.status(400).json({ message: 'Category name is required.' }); res.status(201).json(await Category.create({ name, description: cleanString(req.body.description,300), image: req.body.image || '' })); }));
app.put('/api/admin/categories/:id', protect, adminOnly, asyncRoute(async (req, res) => { const category = await Category.findByIdAndUpdate(req.params.id, { name: cleanString(req.body.name,60), description: cleanString(req.body.description,300), image: req.body.image }, { new: true, runValidators: true }); if (!category) return res.status(404).json({ message: 'Category not found.' }); res.json(category); }));
app.delete('/api/admin/categories/:id', protect, adminOnly, asyncRoute(async (req, res) => { if (await Food.exists({ category: req.params.id })) return res.status(409).json({ message: 'Move or remove foods in this category first.' }); const category = await Category.findByIdAndDelete(req.params.id); if (!category) return res.status(404).json({ message: 'Category not found.' }); res.json({ message: 'Category deleted.' }); }));

app.use((req, res) => res.status(404).json({ message: 'That endpoint could not be found.' }));
app.use((err, req, res, next) => { console.error(err); const status = err.status || (err.code === 11000 ? 409 : err.name === 'ValidationError' ? 400 : 500); res.status(status).json({ message: err.code === 11000 ? 'That record already exists.' : status < 500 ? err.message : 'Something went wrong. Please try again.' }); });
const port = process.env.PORT || 4000;
if (process.env.MONGO_URI) connectDB().then(() => app.listen(port, () => console.log(`BiteBox API listening on ${port}`))).catch(err => { console.error('Database connection failed:', err.message); process.exit(1); });
else app.listen(port, () => console.log(`BiteBox API listening on ${port} with local SQLite catalog (${localCatalog.path})`));
