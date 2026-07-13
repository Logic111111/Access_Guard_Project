import React from "react";
import { ResponsiveContainer, LineChart, Line } from "recharts";

export default function Sparkline({ data, color = "#00E5FF", height = 60 }) {
  const arr = data.map((v, i) => ({ i, v }));
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <LineChart data={arr}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            style={{ filter: `drop-shadow(0 0 6px ${color})` }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
