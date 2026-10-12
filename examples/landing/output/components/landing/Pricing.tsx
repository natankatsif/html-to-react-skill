import PlanCard from "./PlanCard";

const plans = [
    {
        name: "Hobby",
        price: <>$0<span className="text-base text-(color:--muted) font-medium">/mo</span></>,
        href: "/signup?plan=hobby",
        perks: ["1 site", "10k events"],
    },
    {
        featured: true,
        name: "Team",
        price: <>$19<span className="text-base text-(color:--muted) font-medium">/mo</span></>,
        href: "/signup?plan=team",
        perks: ["10 sites", "1M events", "Slack digest"],
    },
    {
        name: "Business",
        price: <>$79<span className="text-base text-(color:--muted) font-medium">/mo</span></>,
        href: "/signup?plan=business",
        perks: ["Unlimited sites", "10M events", "Slack digest", "SSO"],
    },
];

export default function Pricing() {
    return (
        <section id="pricing" className="bg-slate-50 px-0 py-20">
            <div className="max-w-[1040px] mx-auto my-0 px-6 py-0">
                <h2 className="font-bold text-[34px] text-center mt-0 mb-10 mx-0">Simple pricing</h2>
                <div className="grid grid-cols-[repeat(3,1fr)] gap-6 [align-items:start] max-md:grid-cols-[1fr]">
                    {plans.map((plan) => <PlanCard key={plan.href} {...plan} />)}
                </div>
            </div>
        </section>
    );
}
