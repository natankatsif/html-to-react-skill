"use client";

import { useState } from "react";
import Link from "next/link";

const navLinks = [
    { href: "#features", label: "Features" },
    { href: "#pricing", label: "Pricing" },
    { href: "#faq", label: "FAQ" },
];

export default function Header() {
    const [menuOpen, setMenuOpen] = useState(false);

    return (
        <header className="border-b-(color:--line) bg-white border-b border-solid">
            <div className="max-w-[1040px] flex items-center justify-between h-16 mx-auto my-0 px-6 py-0">
                <Link href="/" className="text-inherit no-underline font-extrabold text-[22px]">Lumen<span className="text-(color:--brand)">.</span></Link>
                <button
                    type="button"
                    className="hidden bg-transparent text-2xl cursor-pointer border-0 max-md:block"
                    aria-label="Open menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    ☰
                </button>
                <nav className={`${menuOpen ? "open " : ""}flex items-center gap-7 max-md:hidden max-md:absolute max-md:bg-white max-md:flex-col max-md:border-b-(color:--line) max-md:px-6 max-md:py-4 max-md:border-b max-md:border-solid max-md:top-16 max-md:inset-x-0 max-md:[&.open]:flex`}>
                    {navLinks.map((navLink) => (
                        <a
                            key={navLink.href}
                            href={navLink.href}
                            className="no-underline text-(color:--muted) font-medium hover:text-(color:--ink)"
                        >
                            {navLink.label}
                        </a>
                    ))}
                    <Link
                        href="/signup"
                        className="no-underline text-white inline-block font-semibold transition-transform duration-150 ease-[ease] text-sm px-3.5 py-2 rounded-[10px] [background:var(--brand)] hover:-translate-y-px"
                    >
                        Start free
                    </Link>
                </nav>
            </div>
        </header>
    );
}
