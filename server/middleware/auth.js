import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';
import { localCatalog } from '../localCatalog.js';
export async function protect(req, res, next) {
  try {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Please sign in to continue.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET || localCatalog.jwtSecret);
    const user = process.env.MONGO_URI ? await User.findById(payload.id) : localCatalog.users.findById(payload.id);
    if (!user || user.disabled) return res.status(401).json({ message: 'Your session is no longer valid.' });
    req.user = user; next();
  } catch { res.status(401).json({ message: 'Your session is invalid or has expired.' }); }
}
export function adminOnly(req, res, next) { if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Administrator access required.' }); next(); }
