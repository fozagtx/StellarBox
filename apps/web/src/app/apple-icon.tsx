import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#121212" }}>
        <svg width="108" height="108" viewBox="0 0 24 24" fill="none">
          <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" stroke="#ffffff" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="#ffffff" strokeWidth="2.2" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    size
  );
}
