/**
 * Compact dual-32-bit FNV-1a structural fingerprint.
 *
 * Replaces `JSON.stringify` equality checks where retaining megabytes of
 * serialized history strings only to compare versions wastes heap and GC time.
 */
export function fingerprint(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let count = 0;

  const mix = (code) => {
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x85ebca6b);
    count += 1;
  };

  const mixString = (text) => {
    mix(text.length);
    for (let index = 0; index < text.length; index += 1) mix(text.charCodeAt(index));
  };

  const walk = (item) => {
    if (item === null) {
      mix(0);
      return;
    }
    const kind = typeof item;
    if (kind === "undefined") {
      mix(1);
      return;
    }
    if (kind === "boolean") {
      mix(item ? 2 : 3);
      return;
    }
    if (kind === "number") {
      mix(4);
      mixString(Object.is(item, -0) ? "-0" : String(item));
      return;
    }
    if (kind === "string") {
      mix(5);
      mixString(item);
      return;
    }
    if (Array.isArray(item)) {
      mix(6);
      mix(item.length);
      for (let index = 0; index < item.length; index += 1) walk(item[index]);
      mix(7);
      return;
    }
    if (kind === "object") {
      mix(8);
      const keys = Object.keys(item);
      mix(keys.length);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        mixString(key);
        walk(item[key]);
      }
      mix(9);
      return;
    }
    mix(10);
    mixString(String(item));
  };

  walk(value);
  return `${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}:${count}`;
}
