// The Formicand five-node mark, copied from web/assets/brand/app-icon.svg (128 × 128 grid).
// Nodes form one chain; a signal ring leaves the largest node and visits the others in
// turn, one node per 1.2 s, so the 6 s loop closes exactly.
const nodes = [
  { at: [60.7569, 60.7569], r: 20.189 },
  { at: [21.7749, 71.5816], r: 5.155 },
  { at: [40.6538, 40.6538], r: 14.175 },
  { at: [71.5816, 21.7749], r: 5.155 },
  { at: [26.8651, 26.8651], r: 9.45 }
].map(({ at, r }) => ({ cx: at[0] + r, cy: at[1] + r, r }));
const links = [
  ["translate(35.0664 77.3704)", "M.133-1.713l22.754 1.773-.267 3.426-22.753-1.773z"],
  ["translate(33.3486 65.4404)", "M9.028 1.351l-7.967 6.256-2.122-2.703 7.966-6.255z"],
  ["translate(65.4404 33.3486)", "M7.607 1.061l-6.256 7.967-2.702-2.123 6.255-7.966z"],
  ["translate(48.4495 28.7755)", "M-.389 3.049l20.337-4.723 .777 3.348-20.336 4.722z"]
];
const STEP = 1.2;
const RING = 2.4;
const INK = "#f5f5f7";

export default function Mark({ x, y, size, time = 0 }) {
  const scale = size / 128;
  return (
    <g transform={`translate(${x} ${y}) scale(${scale}) translate(2.545 2.545)`}>
      {nodes.map((node, index) => {
        // Each ring's age wraps with the loop, so a ring still fading at 6 s continues at 0 s.
        const age = (((time - index * STEP) % 6) + 6) % 6;
        if (age > RING) return null;
        const progress = age / RING;
        const eased = 1 - (1 - progress) ** 3;
        return (
          <circle
            key={`ring-${index}`}
            cx={node.cx}
            cy={node.cy}
            r={node.r + 1.5 + eased * 12}
            fill="none"
            stroke="#ffffff"
            strokeWidth={0.9}
            opacity={0.55 * (1 - progress)}
          />
        );
      })}
      {links.map(([transform, d]) => (
        <path key={transform} transform={transform} d={d} fill={INK} />
      ))}
      {nodes.map((node) => (
        <circle key={`${node.cx}-${node.cy}`} cx={node.cx} cy={node.cy} r={node.r} fill={INK} />
      ))}
    </g>
  );
}
