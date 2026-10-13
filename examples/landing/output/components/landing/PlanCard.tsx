import { type ReactNode } from "react";
import Link from "next/link";

type PlanCardProps = {
    featured?: boolean;
    name: string;
    price: ReactNode;
    perks: string[];
    href: string;
};

export default function PlanCard({ featured, name, price, perks, href }: PlanCardProps) {
    return (
        <div className={featured ? "bg-white border-(color:--brand) shadow-[0_20px_40px_-20px_rgba(109,40,217,0.45)] p-7 rounded-2xl border-2 border-solid" : "bg-white border border-(color:--line) p-7 rounded-2xl border-solid"}>
            <h3 className="font-bold text-[18px] m-0">{name}</h3>
            <p className="text-[40px] font-extrabold mt-2 mb-4 mx-0">{price}</p>
            <ul className="list-disc text-(color:--muted) mt-0 mb-6 mx-0 pl-[18px]">
                {perks.map((perk, index) => <li key={index}>{perk}</li>)}
            </ul>
            <Link
                href={href}
                className={featured ? "no-underline text-white font-semibold transition-transform duration-150 ease-[ease] block text-center px-[22px] py-3 rounded-[10px] [background:var(--brand)] hover:-translate-y-px" : "no-underline font-semibold transition-transform duration-150 ease-[ease] text-(color:--brand) bg-transparent shadow-[inset_0_0_0_1px_var(--brand)] block text-center px-[22px] py-3 rounded-[10px] hover:-translate-y-px"}
            >
                Choose
            </Link>
        </div>
    );
}
