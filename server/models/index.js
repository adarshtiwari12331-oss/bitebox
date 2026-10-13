import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const addressSchema = new mongoose.Schema({ label: { type: String, default: 'Home' }, recipient: String, phone: String, line1: { type: String, required: true }, line2: String, city: { type: String, required: true }, state: String, postalCode: String, instructions: String }, { _id: true });
const userSchema = new mongoose.Schema({ name: { type: String, required: true, trim: true, maxlength: 80 }, email: { type: String, required: true, unique: true, lowercase: true, trim: true }, password: { type: String, required: true, minlength: 8, select: false }, phone: String, avatar: String, role: { type: String, enum: ['customer', 'admin'], default: 'customer' }, disabled: { type: Boolean, default: false }, addresses: [addressSchema], favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Food' }] }, { timestamps: true });
userSchema.pre('save', async function () { if (this.isModified('password')) this.password = await bcrypt.hash(this.password, 12); });
userSchema.methods.comparePassword = function (password) { return bcrypt.compare(password, this.password); };
export const User = mongoose.model('User', userSchema);

const categorySchema = new mongoose.Schema({ name: { type: String, required: true, unique: true, trim: true }, slug: { type: String, unique: true }, description: String, image: String }, { timestamps: true });
categorySchema.pre('save', function () { if (!this.slug) this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); });
export const Category = mongoose.model('Category', categorySchema);

const optionSchema = new mongoose.Schema({ name: String, price: { type: Number, min: 0 } }, { _id: false });
const foodSchema = new mongoose.Schema({ name: { type: String, required: true, trim: true, maxlength: 120 }, description: { type: String, required: true }, price: { type: Number, required: true, min: 0 }, image: { type: String, required: true }, category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true }, ingredients: [String], dietaryInfo: [String], tags: [String], options: [optionSchema], isVeg: { type: Boolean, default: true }, available: { type: Boolean, default: true }, rating: { type: Number, default: 0, min: 0, max: 5 }, reviewCount: { type: Number, default: 0 }, popularity: { type: Number, default: 0 } }, { timestamps: true });
foodSchema.index({ name: 'text', description: 'text', tags: 'text' }); foodSchema.index({ category: 1, available: 1 });
export const Food = mongoose.model('Food', foodSchema);

const orderLine = new mongoose.Schema({ food: { type: mongoose.Schema.Types.ObjectId, ref: 'Food' }, name: String, image: String, option: String, unitPrice: Number, quantity: { type: Number, min: 1 } }, { _id: false });
const orderSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, items: [orderLine], address: { label: String, recipient: String, phone: String, line1: String, line2: String, city: String, state: String, postalCode: String, instructions: String }, subtotal: Number, tax: Number, deliveryFee: Number, discount: Number, total: Number, paymentMethod: { type: String, default: 'test' }, paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'paid' }, orderStatus: { type: String, enum: ['Pending', 'Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled'], default: 'Confirmed' } }, { timestamps: true });
export const Order = mongoose.model('Order', orderSchema);

const reviewSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, food: { type: mongoose.Schema.Types.ObjectId, ref: 'Food', required: true }, order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true }, rating: { type: Number, min: 1, max: 5, required: true }, comment: { type: String, trim: true, maxlength: 1000 } }, { timestamps: true });
reviewSchema.index({ user: 1, food: 1, order: 1 }, { unique: true });
export const Review = mongoose.model('Review', reviewSchema);
