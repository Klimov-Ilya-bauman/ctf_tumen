import { encryptBoard, decryptBoard } from './gf251.js';
import { applyMove } from './board.js';

export function computeNextC(prevC, M, r, c, color, S) {
  const { M2 } = applyMove(M, r, c, color);
  return { C2: encryptBoard(M2, S), M2 };
}

export function recoverMFromC(C, S) { return decryptBoard(C, S); }

export function isValidBoard(M) {
  if (M.length !== 361) return false;
  for (let i = 0; i < M.length; i++) if (M[i] > 2) return false;
  return true;
}
