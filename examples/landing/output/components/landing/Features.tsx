import { ChartLine, Lock, Send } from "lucide-react";

const features = [
    {
        icon: <ChartLine className="inline align-baseline w-[22px] h-[22px]" />,
        title: "One clear chart",
        text: "Visitors, signups and revenue on a single timeline.",
    },
    {
        icon: <Lock className="inline align-baseline w-[22px] h-[22px]" />,
        title: "Private by default",
        text: "No cookies, no personal data, no consent banner.",
    },
    {
        icon: <Send className="inline align-baseline w-[22px] h-[22px]" />,
        title: "Daily digest",
        text: "A short report in Slack or email at 9:00 every day.",
    },
];

export default function Features() {
    return (
        <section id="features" className="px-0 py-20">
            <div className="max-w-[1040px] mx-auto my-0 px-6 py-0">
                <h2 className="font-bold text-[34px] text-center mt-0 mb-10 mx-0">Built for busy teams</h2>
                <div className="grid grid-cols-[repeat(3,1fr)] gap-6 max-md:grid-cols-[1fr]">
                    {features.map((feature) => (
                        <div key={feature.title} className="border border-(color:--line) p-7 rounded-2xl border-solid">
                            <div className="w-11 h-11 grid place-items-center text-(color:--brand) rounded-xl [background:var(--brand-soft)]">
                                {feature.icon}
                            </div>
                            <h3 className="font-bold text-[19px] mt-[18px] mb-1.5 mx-0">{feature.title}</h3>
                            <p className="text-(color:--muted) m-0">{feature.text}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
