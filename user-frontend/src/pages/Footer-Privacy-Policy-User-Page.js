import React from "react";
import Footer from "../components/Footer-User-Component";
import { Link } from "react-router-dom";
import Seo from "../components/Seo";
import "./legal-prose.css";

function PrivacyPolicy() {
  const lastUpdated = new Date().toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex flex-col min-h-screen">
      <Seo
        title="Privacy Policy | Magis Gold & Gems Pawnshop"
        description="How Magis Gold & Gems collects, uses, and protects your personal data under the Philippine Data Privacy Act (RA 10173), including your data subject rights."
        path="/privacy-policy"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Privacy Policy", path: "/privacy-policy" },
        ]}
      />
      {/* Hero */}
      <section
        className="relative h-64 md:h-72 bg-cover bg-center"
        style={{ backgroundImage: "url('/images/hero.jpg')" }}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e]/90 via-[#1a1a2e]/80 to-[#2d2d42]/85" />
        <div className="relative z-10 flex h-full flex-col items-center justify-center px-4 text-center text-white">
          <h1 className="mb-2 text-3xl font-extrabold tracking-tight md:text-5xl">Privacy Policy</h1>
          <p className="text-sm text-gray-300 md:text-base">Last updated: {lastUpdated}</p>
        </div>
      </section>

      <main className="flex-grow legal-prose">
        {/* Intro */}
        <section className="py-10 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <p className="text-sm text-gray-700">
              This Policy explains how Magis Gold & Gems Pawnshop & Jewelry collects, uses, shares, and
              protects your personal data when you use our website, branch finder and maps, live chat, and
              contact forms. We comply with the Data Privacy Act of 2012 (RA 10173), its Implementing Rules,
              and National Privacy Commission (NPC) issuances. For pawn and related transactions, other
              Philippine laws also apply, including the Pawnshop Regulation Act (RA 9474), Bangko Sentral ng
              Pilipinas (BSP) rules, and the Anti-Money Laundering Act (RA 9160, as amended).
            </p>
          </div>
        </section>

        {/* The Policy */}
        <section className="py-10 bg-[#faf8f5]">
          <div className="container mx-auto px-4 max-w-4xl space-y-8 text-gray-800">
            <div>
              <h2 className="text-xl font-semibold mb-2">1) Who We Are & Scope</h2>
              <p className="text-sm">
                Magis Gold & Gems Pawnshop & Jewelry (“Magis,” “we,” “us,” or “our”) is the Personal
                Information Controller for the personal data described here. Our head office is at 3rd Floor,
                LVNG Building, Aniceto Gueco Street, Barangay Balibago, Angeles City, Pampanga 2009,
                Philippines.
              </p>
              <p className="text-sm mt-2">
                This Policy covers personal data we process online — through this website
                (www.magispawnshop.com), the branch finder and maps, the live chat, and our contact and
                transcript forms — and in-branch when you make inquiries or complete transactions. It does
                not cover third-party sites we link to, which have their own privacy policies.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">2) What We Collect</h2>
              <ul className="list-disc pl-6 text-sm space-y-1">
                <li>Information you choose to give us: your name, email, phone, and the contents of any message, attachment, or transcript request you send through chat or our forms.</li>
                <li>Live chat data: your messages, any images or PDFs you upload, the branch you are chatting with, timestamps, and a randomly generated anonymous chat ID. You are not required to sign up or give your name or email to use live chat.</li>
                <li>Transaction-related information (in-branch or by arrangement): item descriptions, appraisals, and the branch chosen.</li>
                <li>Identity / KYC information for in-branch transactions: a valid government ID and related details where required by law.</li>
                <li>Technical and usage data collected automatically: IP address, approximate location (city or country inferred from your IP), browser and device details, network type, and the pages or features you use.</li>
                <li>Security data used to detect and prevent fraud, abuse, and bots (for example, rate-limit signals and bot-verification results).</li>
              </ul>
              <p className="text-sm mt-3">
                Please do not share sensitive details in live chat — such as full card numbers, PINs,
                passwords, or full government ID numbers. Our chat warns you when it detects such data and
                automatically masks recognized sensitive details before the message is stored; even so,
                please avoid sending them. Official identity verification is done securely in-branch.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">3) Where We Get It</h2>
              <p className="text-sm">
                We collect personal data directly from you (when you message us, fill in a form, request a
                transcript, call us, or transact in-branch); automatically from your device (through cookies,
                browser storage, and similar technologies when you use the site); and from service providers
                that help us run the site and chat, such as bot-protection and security results.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">4) Why We Use Your Data</h2>
              <ul className="list-disc pl-6 text-sm space-y-1">
                <li>Operate and secure the website, branch finder and maps, and the live chat.</li>
                <li>Respond to your inquiries and provide support, including follow-ups by email, SMS, or phone.</li>
                <li>Arrange or complete in-branch services and keep accurate records.</li>
                <li>Comply with legal obligations, including identity checks and record-keeping under BSP pawnshop rules and the AMLA.</li>
                <li>Protect our users and services — preventing fraud, abuse, spam, and bots; enforcing rate limits; and investigating incidents.</li>
                <li>Maintain, troubleshoot, and improve our services.</li>
                <li>Send updates or offers where you have consented (you can withdraw consent any time).</li>
              </ul>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">5) Legal Bases</h2>
              <p className="text-sm">
                Under the Data Privacy Act, we process personal data on one or more of these bases: your
                consent; performance of a service or transaction you request; compliance with a legal
                obligation (such as BSP and AMLA requirements); protection of vital interests; and our
                legitimate interests — for example, securing our services, preventing abuse, and improving
                the site — where not overridden by your rights. Sensitive personal information is processed
                only where allowed by law, such as with your consent or as required by regulation.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">6) Cookies, Local Storage & Similar Tools</h2>
              <p className="text-sm">
                We use cookies and browser storage (localStorage and sessionStorage) mainly to make the
                site and chat work — not for advertising. These include:
              </p>
              <ul className="list-disc pl-6 text-sm space-y-1 mt-2">
                <li>Essential and functional: a secure chat session token (guestToken), an anonymous chat ID (guestId), the selected branch, a tab identifier, and a temporary on-device cache of your current conversation so it survives reloads.</li>
                <li>Security: Cloudflare Turnstile, which helps us tell humans from bots when you start a chat.</li>
              </ul>
              <p className="text-sm mt-2">
                We do not use third-party advertising cookies or third-party analytics trackers. Some pages
                embed services from other companies — Google Maps, Google Fonts, and Facebook or Instagram
                content and links — which may receive your IP address and set their own cookies under their
                own policies. You can manage or block cookies in your browser; disabling essential cookies or
                storage may break chat and other features.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">7) Live Chat & Communications</h2>
              <p className="text-sm">
                Our live chat lets you message a branch without creating an account. When you open a chat we
                assign a random, anonymous identifier and a temporary session token; we do not require your
                name or email. You may voluntarily share information in your messages, upload images or PDFs,
                and optionally enter your email to have a transcript sent to you.
              </p>
              <ul className="list-disc pl-6 text-sm space-y-1 mt-2">
                <li>Messages travel over encrypted connections (TLS) and are additionally encrypted at the application layer using keys we manage. Uploaded files are stored privately and shared only through short-lived, access-controlled links.</li>
                <li>Our system automatically detects and masks recognized sensitive details (such as card or government ID numbers) before a message is stored, and logs only that sensitive data was detected — not the data itself.</li>
                <li>Authorized branch staff can read your chat and its history to assist you. Staff access is protected by passwords and one-time email codes (multi-factor authentication).</li>
              </ul>
              <p className="text-sm mt-2">
                We may retain chat messages to resolve your inquiry, keep service records, and improve
                support. Live chat is for inquiries and support only — it does not create a pawn contract or
                any binding transaction. Official records are issued in-branch.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">8) Sharing & Service Providers</h2>
              <p className="text-sm">
                We do not sell your personal data. We share it only as needed to run our services and as
                permitted by law, including with:
              </p>
              <ul className="list-disc pl-6 text-sm space-y-1 mt-2">
                <li>Cloud hosting, database, and storage — Google (Firebase / Firestore and Google Cloud Storage) and our application host (Render).</li>
                <li>Security and delivery — Cloudflare — for content delivery, routing, and bot protection (Turnstile).</li>
                <li>Maps and fonts — Google (Google Maps and Google Fonts) — to show branch locations and render the site.</li>
                <li>Communications — email delivery services used to send transcripts, replies, and one-time codes.</li>
                <li>Social media — Facebook and Instagram — when you interact with embedded content or links.</li>
              </ul>
              <p className="text-sm mt-2">
                These providers process data under our instructions and appropriate safeguards. We may also
                disclose data when required by law or legal process, or to protect the rights, property, or
                safety of our customers, the public, or Magis.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">9) Transfers Outside the Philippines</h2>
              <p className="text-sm">
                Some providers (such as Google, Cloudflare, and email services) may store or process data on
                servers outside the Philippines. Where this happens, we use appropriate contractual and
                organizational safeguards so your data receives protection consistent with the Data Privacy
                Act.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">10) Retention</h2>
              <p className="text-sm">
                We keep personal data only as long as necessary for the purposes above, for periods required
                by law (for example, BSP and AMLA record-keeping for pawn transactions), and to establish or
                defend legal claims. Chat sessions and on-device caches are kept for a limited time, then
                deleted or anonymized. When data is no longer needed, we securely delete or anonymize it.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">11) Security</h2>
              <p className="text-sm">
                We apply organizational, physical, and technical safeguards appropriate to the risk,
                including: encryption in transit (HTTPS/TLS) and application-layer encryption of chat
                messages; private file storage with short-lived access links; multi-factor authentication and
                access controls for staff; rate-limiting, bot protection, and abuse detection; and audit
                logging. No system is perfectly secure, but we review and improve our measures regularly. If a
                breach likely to cause serious harm occurs, we will notify the NPC and affected individuals as
                required by law.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">12) Your Privacy Rights</h2>
              <ul className="list-disc pl-6 text-sm space-y-1">
                <li>To be informed about how your data is collected and used.</li>
                <li>To access the personal data we hold about you.</li>
                <li>To correct (rectify) inaccurate or incomplete data.</li>
                <li>To object to processing, including for direct marketing.</li>
                <li>To erase or block your data in the cases allowed by law.</li>
                <li>To data portability — a copy of data you provided, in a commonly used electronic format.</li>
                <li>To withdraw consent at any time (this does not affect processing already carried out).</li>
                <li>To be indemnified for damages, and to lodge a complaint with the National Privacy Commission (NPC).</li>
              </ul>
              <p className="text-sm mt-2">
                To exercise any right, contact our Data Protection Officer (Section 16). We may need to verify
                your identity before acting on a request.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">13) Children’s Privacy</h2>
              <p className="text-sm">
                Our services are intended for adults (and, for transactions, persons of legal age). We do not
                knowingly collect personal data from minors without the consent of a parent or guardian. If
                you believe a minor has given us data without proper consent, please contact us and we will
                take appropriate steps.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">14) Marketing Choices</h2>
              <p className="text-sm">
                We send marketing messages only where permitted or with your consent. You can opt out any
                time using the unsubscribe option or by contacting us. We may still send transactional or
                service-related messages, such as replies to your inquiry or one-time security codes.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">15) Updates to This Policy</h2>
              <p className="text-sm">
                We may change this Policy from time to time. We will post the updated version with a new
                “Last updated” date. Continued use of the site means you accept the changes.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">16) How to Contact Us</h2>
              <p className="text-sm">
                For questions, requests, or complaints about your personal data, contact our Data Protection
                Officer (DPO):<br />
                <span className="font-medium">DPO email:</span> dpo@magispawnshop.com<br />
                <span className="font-medium">General inquiries:</span> magisgoldandgems.pawnshop@gmail.com<br />
                <span className="font-medium">Phone:</span> +63 962 061 8672<br />
                <span className="font-medium">Address:</span> 3rd Floor, LVNG Building, Aniceto Gueco Street, Barangay Balibago, Angeles City, Pampanga 2009, Philippines
              </p>
              <p className="text-xs text-gray-600 mt-3">
                If you believe your rights have been violated, you may also file a complaint with the National
                Privacy Commission (NPC) at <em>privacy.gov.ph</em>.
              </p>
            </div>
          </div>
        </section>

        {/* CTAs */}
        <section className="py-10 bg-white">
          <div className="container mx-auto px-4 max-w-4xl text-center">
            <p className="text-gray-700 mb-6">Need help or want to exercise your privacy rights?</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/contact-us"
                className="rounded-full bg-gradient-to-br from-[#d4a853] to-[#c9a227] px-6 py-3 font-semibold text-[#1a1a2e] transition hover:brightness-95"
              >
                Contact Us
              </Link>
              <Link
                to="/branches"
                className="rounded-full bg-[#1a1a2e] px-6 py-3 font-semibold text-[#d4a853] transition hover:bg-[#2d2d42]"
              >
                Find a Branch
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <Footer />
    </div>
  );
}

export default PrivacyPolicy;
