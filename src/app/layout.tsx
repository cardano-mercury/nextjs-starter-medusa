import { getBaseURL } from "@lib/util/env"
import { Metadata } from "next"
import "styles/globals.css"
import "@meshsdk/react/styles.css"
// import { MeshProvider } from "@meshsdk/react"

export const metadata: Metadata = {
  metadataBase: new URL(getBaseURL()),
}

export default function RootLayout(props: { children: React.ReactNode }) {
  return (
    <html lang="en" data-mode="light">
      <body>
        <main className="relative">
          {/*<MeshProvider>*/}
          {props.children}
          {/*</MeshProvider>*/}
        </main>
      </body>
    </html>
  )
}
