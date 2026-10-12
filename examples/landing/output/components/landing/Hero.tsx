import Link from "next/link";

export default function Hero() {
    return (
        <section className="text-center pt-24 pb-20 px-0 [background:linear-gradient(180deg,var(--brand-soft),#fff)]">
            <div className="max-w-[1040px] mx-auto my-0 px-6 py-0">
                <div>
                    <p className="text-(color:--brand) font-semibold uppercase tracking-[0.08em] text-[13px] [margin-block:1em]">Analytics without the noise</p>
                    <h1 className="font-bold text-[52px] leading-[1.1] mt-3 mb-[18px] mx-0 max-md:text-4xl">Know what works.<br />Skip the dashboards.</h1>
                    <p className="text-(color:--muted) text-[19px] max-w-[560px] mt-0 mb-8 mx-auto">
                        Lumen shows the three numbers your team actually checks — and sends them to Slack every morning.
                    </p>
                    <div className="flex gap-3 justify-center">
                        <Link
                            href="/signup"
                            className="no-underline text-white inline-block font-semibold transition-transform duration-150 ease-[ease] px-[22px] py-3 rounded-[10px] [background:var(--brand)] hover:-translate-y-px"
                        >
                            Start free
                        </Link>
                        <a
                            href="#features"
                            className="no-underline inline-block font-semibold transition-transform duration-150 ease-[ease] text-(color:--brand) bg-transparent shadow-[inset_0_0_0_1px_var(--brand)] px-[22px] py-3 rounded-[10px] hover:-translate-y-px"
                        >
                            See how it works
                        </a>
                    </div>
                </div>
            </div>
        </section>
    );
}
