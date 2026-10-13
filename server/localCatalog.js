import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { categoryData, foods, foodImage, image } from './seed/seed.js';

const dbPath = fileURLToPath(new URL('./data/bitebox.sqlite', import.meta.url));
mkdirSync(path.dirname(dbPath), { recursive: true });
const imagePool = ['photo-1579751626657-72bc17010498','photo-1568901346375-23c9450c58cd','photo-1569718212165-3a8278d5f624','photo-1512621776951-a57141f2eefd','photo-1563805042-7684c019e1cb','photo-1544145945-f90425340c7e','photo-1551504734-5ee1c4a1479b','photo-1573080496219-bb080dd4f877','photo-1546069901-ba9599a7e63c','photo-1555939594-58d7cb561ad1','photo-1565299624946-b28f40a0ae38','photo-1547592180-85f173990554'];
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT, image TEXT);
CREATE TABLE IF NOT EXISTS foods(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, price REAL NOT NULL, image TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), ingredients TEXT NOT NULL, dietary_info TEXT NOT NULL, tags TEXT NOT NULL, options TEXT NOT NULL, is_veg INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1, rating REAL NOT NULL, review_count INTEGER NOT NULL, popularity INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', phone TEXT, avatar TEXT, addresses TEXT NOT NULL DEFAULT '[]', favorites TEXT NOT NULL DEFAULT '[]', disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS foods_category_idx ON foods(category_id, available);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
`);

if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  db.exec('DELETE FROM foods; DELETE FROM categories; PRAGMA user_version=2;');
}

if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const catInsert = db.prepare('INSERT INTO categories VALUES(?,?,?,?,?)');
  const catIds = categoryData.map(([name, description, photo]) => {
    const id = randomUUID(); const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
    catInsert.run(id, name, slug, description, image(photo)); return id;
  });
  const insert = db.prepare('INSERT INTO foods VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  foods.forEach(([name,description,price,cat,isVeg,ingredients],i) => {
    insert.run(randomUUID(),name,description,price,image(imagePool[i%imagePool.length]),catIds[cat],JSON.stringify(ingredients),JSON.stringify(isVeg?['Vegetarian']:[]),JSON.stringify([...ingredients,name.split(' ')[0].toLowerCase()]),JSON.stringify(cat===1?[{name:'Regular',price:0},{name:'Family pack',price:199}]:[]),isVeg?1:0,1,[4.5,4.8,4.7,4.4,4.9][i%5],[38,21,56,14,89][i%5],100-i*2,new Date().toISOString());
  });
}

// Keep the local catalog's existing rows in sync with the dish-specific menu photos.
const updateFoodImage = db.prepare('UPDATE foods SET image = ? WHERE name = ?');
for (const [name] of foods) updateFoodImage.run(foodImage(name), name);

const parse = value => { try { return JSON.parse(value || '[]'); } catch { return []; } };
const categories = () => db.prepare('SELECT id AS _id, name, slug, description, image FROM categories ORDER BY name').all();
const mapUser = user => user && ({ _id:user.id, name:user.name, email:user.email, role:user.role, phone:user.phone, avatar:user.avatar, addresses:parse(user.addresses), favorites:parse(user.favorites), disabled:!!user.disabled, createdAt:user.created_at });
const userById = db.prepare('SELECT * FROM users WHERE id = ?');
const userByEmail = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
const createUserRow = db.prepare('INSERT INTO users (id,name,email,password_hash,created_at) VALUES (?,?,?,?,?)');
const localUsers = {
  findById(id) { return mapUser(userById.get(id)); },
  findByEmail(email) { return mapUser(userByEmail.get(email)); },
  async create({ name, email, password }) {
    const id = randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    createUserRow.run(id, name, email.toLowerCase(), passwordHash, new Date().toISOString());
    return this.findById(id);
  },
  async verify(email, password) {
    const row = userByEmail.get(email);
    return row && !row.disabled && await bcrypt.compare(password, row.password_hash) ? mapUser(row) : null;
  }
};
const foodsByQuery = params => {
  const categoryList = categories(), categoryMap = new Map(categoryList.map(c => [c._id,c]));
  let items = db.prepare('SELECT * FROM foods').all().map(f => ({ _id:f.id,name:f.name,description:f.description,price:f.price,image:f.image,category:categoryMap.get(f.category_id),ingredients:parse(f.ingredients),dietaryInfo:parse(f.dietary_info),tags:parse(f.tags),options:parse(f.options),isVeg:!!f.is_veg,available:!!f.available,rating:f.rating,reviewCount:f.review_count,popularity:f.popularity,createdAt:f.created_at }));
  if (params.get('available') !== 'false') items = items.filter(f => f.available);
  const category = params.get('category'); if (category) items = items.filter(f => f.category?._id === category);
  if (params.get('veg') === 'true') items = items.filter(f => f.isVeg); if (params.get('veg') === 'false') items = items.filter(f => !f.isVeg);
  const maxPrice = Number(params.get('maxPrice')); if (params.has('maxPrice') && Number.isFinite(maxPrice)) items = items.filter(f => f.price <= maxPrice);
  const minRating = Number(params.get('minRating')); if (params.has('minRating') && Number.isFinite(minRating)) items = items.filter(f => f.rating >= minRating);
  const search = (params.get('search') || '').toLowerCase().trim(); if (search) items = items.filter(f => [f.name,f.description,f.category?.name,...f.tags].join(' ').toLowerCase().includes(search));
  const sorts = { popular:(a,b)=>b.popularity-a.popularity, price_asc:(a,b)=>a.price-b.price, price_desc:(a,b)=>b.price-a.price, rating:(a,b)=>b.rating-a.rating, newest:(a,b)=>b.createdAt.localeCompare(a.createdAt) };
  items.sort(sorts[params.get('sort')] || sorts.popular);
  const total = items.length, limit = Math.min(48,Math.max(1,Number(params.get('limit'))||12)), page = Math.max(1,Number(params.get('page'))||1);
  return { foods:items.slice((page-1)*limit,page*limit), page, pages:Math.ceil(total/limit), total };
};
export const localCatalog = {
  categories,
  foods: foodsByQuery,
  users: localUsers,
  jwtSecret: 'bitebox-local-development-only-secret-change-before-deployment',
  food(id) { const result = foodsByQuery(new URLSearchParams({available:'false',limit:'48'})); return result.foods.find(f => f._id === id) || null; },
  get status() { return 'connected'; },
  get path() { return path.normalize(dbPath); }
};
