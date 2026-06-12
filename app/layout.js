import "./globals.css";

export const metadata = {
  title: "LongDrives — scenic drive planner",
  description:
    "Tell us how long you want to drive. We find a smooth, scenic route and open it in Google Maps.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
