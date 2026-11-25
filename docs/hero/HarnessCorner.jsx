// The top-left corner of the desktop App, redrawn from the current dark theme.
// Nothing here is a screenshot; labels are illustrative.
function Icon({ kind, x, y, size = 18 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </>
    ),
    chat: <path d="M5 5h14v10H10l-5 4z" />,
    radar: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4" />
        <path d="M12 12l5-5" />
      </>
    ),
    folder: <path d="M3 6h7l2 3h9v10H3z" />,
    folderOpen: <path d="M3 6h7l2 3h7v2H7l-3 8H3zM4 19l3-8h15l-3 8z" />,
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M10 4v16" />
      </>
    ),
    chevron: <path d="m9 6 6 6-6 6" />
  };
  return (
    <g
      transform={`translate(${x} ${y}) scale(${size / 24})`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[kind]}
    </g>
  );
}

const conversations = [
  ["Release checklist", true],
  ["Fix flaky upload test", false],
  ["Docs cleanup", false]
];

export default function HarnessCorner({ x, y }) {
  return (
    <g transform={`translate(${x} ${y})`} fontFamily="Inter, sans-serif" filter="url(#window-shadow)">
      <rect x="0" y="0" width="820" height="590" rx="16" fill="#0d0d0e" stroke="#2e2e33" />
      {["#ff5f57", "#febc2e", "#28c840"].map((color, i) => (
        <circle key={color} cx={22 + i * 20} cy="22" r="6" fill={color} />
      ))}
      <g color="#8d8d95">
        <Icon kind="panel" x={84} y={13} size={17} />
        <path d="m121 17-4 5 4 5m17-10 4 5-4 5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </g>

      {/* Sidebar */}
      <rect x="12" y="46" width="190" height="34" rx="9" fill="#18181b" />
      <rect x="15" y="49" width="92" height="28" rx="7" fill="#2a2a2f" />
      <g color="#f2f2f4">
        <Icon kind="chat" x={36} y={56} size={14} />
        <text x="55" y="67" fontSize="11.5" fontWeight="600" fill="currentColor">
          Work
        </text>
      </g>
      <g color="#9a9aa2">
        <Icon kind="radar" x={121} y={56} size={14} />
        <text x="140" y="67" fontSize="11.5" fill="currentColor">
          Observe
        </text>
      </g>
      <rect x="10" y="92" width="194" height="32" rx="8" fill="#1f1f23" />
      <g color="#f2f2f4">
        <Icon kind="plus" x={20} y={100} size={15} />
        <text x="44" y="112" fontSize="12" fill="currentColor">
          New conversation
        </text>
      </g>
      <text x="181" y="111" fontSize="8.5" fill="#76767e">
        ⌘K
      </text>
      <g color="#a6a6ae">
        <Icon kind="search" x={20} y={136} size={15} />
        <text x="44" y="148" fontSize="12" fill="currentColor">
          Search
        </text>
      </g>
      <text x="181" y="147" fontSize="8.5" fill="#76767e">
        ⌘P
      </text>
      <text x="18" y="182" fontSize="10.5" fill="#8a8a92">
        Projects
      </text>
      <path d="M186 173v10m-5-5h10" stroke="#8a8a92" strokeWidth="1.2" />
      <g color="#e6e6ea">
        <Icon kind="folderOpen" x={17} y={196} size={14} />
        <text x="38" y="207" fontSize="11.5" fontWeight="600" fill="currentColor">
          formicand
        </text>
      </g>
      {conversations.map(([label, active], i) => {
        const top = 218 + i * 30;
        return (
          <g key={label}>
            {active && <rect x="28" y={top} width="174" height="26" rx="7" fill="#242428" />}
            <text x="40" y={top + 17} fontSize="11" fill={active ? "#f2f2f4" : "#9c9ca4"}>
              {label}
            </text>
          </g>
        );
      })}
      <g color="#9c9ca4">
        <Icon kind="folder" x={17} y={320} size={14} />
        <text x="38" y="331" fontSize="11.5" fill="currentColor">
          agent-factory
        </text>
      </g>

      {/* Conversation panel, cut by the canvas edge */}
      <rect x="214" y="40" width="600" height="550" rx="12" fill="#141416" stroke="#26262b" />
      <g fontSize="10.5">
        <rect x="228" y="62" width="86" height="48" rx="10" fill="#2a2a2f" />
        <text fill="#ececf0">
          <tspan x="238" y="82">
            Ship the fix
          </tspan>
          <tspan x="238" dy="15">
            and its test.
          </tspan>
        </text>
        <text x="228" y="140" fill="#c4c4cc">
          Delegating to
        </text>
        <text x="228" y="156" fill="#c4c4cc">
          two agents.
        </text>
        {[
          ["Executor", "#f5f5f7", 184],
          ["Reviewer", "#6e6e76", 208]
        ].map(([label, dot, top]) => (
          <g key={label}>
            <rect x="228" y={top - 13} width="88" height="20" rx="6" fill="#1c1c20" stroke="#2c2c31" />
            <circle cx="239" cy={top - 3} r="3" fill={dot} />
            <text x="248" y={top + 1} fontSize="10" fill="#b4b4bc">
              {label}
            </text>
          </g>
        ))}
        <path
          d="M228 238H306M228 250H290M228 262H300"
          stroke="#26262b"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
    </g>
  );
}
