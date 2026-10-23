import type { InterfaceCaption } from '../data/interface-copy';

export const HALLUCINATION_CHANCE = 0.55;
export const CORRUPTION_CHANCE = 0.54;
export const EASTER_EGG_CHANCE = 0.91;

export function createCaptionResolver(random: () => number = Math.random) {
  const selected = new WeakMap<InterfaceCaption, InterfaceCaption>();
  const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)];

  return (copy: InterfaceCaption): InterfaceCaption => {
    const cached = selected.get(copy);
    if (cached) return cached;

    let text = copy.text;
    if (copy.hallucinations?.length && random() < HALLUCINATION_CHANCE) {
      text = pick(copy.hallucinations);
    } else if (copy.easterEggs?.length && random() < EASTER_EGG_CHANCE) {
      text = pick(copy.easterEggs);
    }
    if (copy.corruption?.length && random() < CORRUPTION_CHANCE) {
      text += ' ' + pick(copy.corruption);
    }

    const result = { text, stack: copy.stack };
    selected.set(copy, result);
    return result;
  };
}

export const resolveCaption = createCaptionResolver();
