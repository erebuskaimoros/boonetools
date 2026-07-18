// Compatibility facade for existing frontend imports. Blockchain primitives
// live outside src/ so server-side domain modules can use them without taking a
// runtime dependency on the frontend tree.
export * from '../../../shared/blockchain.js';
