import type { Metadata } from "next";
import Link from "next/link";
import Features from "@/components/landing/Features";
import Header from "@/components/landing/Header";
import Hero from "@/components/landing/Hero";
import Pricing from "@/components/landing/Pricing";
import "@/components/landing/landing.css";

export const metadata: Metadata = {
    title: "Lumen — analytics for small teams",
    description: "Simple, privacy-friendly analytics.",
};

export default function LandingPage() {
    return (
        <div className="landing-page leading-normal text-(color:--ink) m-0 [font-family:system-ui,-apple-system,'Segoe_UI',sans-serif]">
            <Header />
            <Hero />
            <Features />
            <Pricing />
            <footer className="border-t-(color:--line) text-(color:--muted) text-sm text-center px-0 py-6 border-t border-solid">
                <div className="max-w-[1040px] mx-auto my-0 px-6 py-0">
                    © 2026 Lumen Labs · <Link href="/privacy" className="text-inherit underline">Privacy</Link>
                </div>
            </footer>
        </div>
    );
}
