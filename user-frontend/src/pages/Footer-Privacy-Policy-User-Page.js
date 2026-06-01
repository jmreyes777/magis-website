import React from "react";
import Footer from "../components/Footer-User-Component";
import { Link } from "react-router-dom";

function PrivacyPolicy() {
  const lastUpdated = new Date().toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="flex flex-col min-h-screen">
      {/* Hero */}
      <section
        className="relative h-64 bg-cover bg-center"
        style={{ backgroundImage: "url('/images/hero.jpg')" }}
      >
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative z-10 flex flex-col items-center justify-center h-full text-center px-4 text-white">
          <h1 className="text-3xl md:text-4xl font-bold mb-2">Privacy Policy</h1>
          <p className="text-sm md:text-base opacity-90">Last updated: {lastUpdated}</p>
        </div>
      </section>

      <main className="flex-grow">
        {/* Intro */}
        <section className="py-10 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <p className="text-sm text-gray-700">
              We respect your privacy. This Policy explains how we collect, use, share, and protect
              your information when you use our website, branch finder, and live chat. We comply with
              the Data Privacy Act of 2012 (RA 10173) and its rules. For pawn transactions, other
              Philippine laws (including BSP pawnshop rules and AMLA) also apply.
            </p>
          </div>
        </section>

        {/* The Policy */}
        <section className="py-6 bg-gray-50">
          <div className="container mx-auto px-4 max-w-4xl space-y-8 text-gray-800">
            <div>
              <h2 className="text-xl font-semibold mb-2">1) Who We Are & Scope</h2>
              <p className="text-sm">
                We act as the Personal Information Controller for this website and our in-branch
                services. This Policy covers data collected online (site, maps, live chat) and in-branch
                when you make inquiries or complete transactions.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">2) What We Collect</h2>
              <ul className="list-disc pl-6 text-sm space-y-1">
                <li>Contact details (name, email, phone); messages you send via live chat or forms.</li>
                <li>Transaction-related information (e.g., item descriptions, appraisals, branch chosen).</li>
                <li>Identity details needed for in-branch transactions (e.g., valid ID as required by law).</li>
                <li>Device and usage data (pages visited, general location, browser settings) for security and performance.</li>
                <li>Branch finder inputs (searches, preferred locations) to show nearby branches.</li>
              </ul>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">3) Where We Get It</h2>
              <p className="text-sm">
                Directly from you (forms, chat, calls, in-branch), automatically from your device when
                you use the site (cookies and similar tools), and from publicly available or lawful sources
                where permitted.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">4) Why We Use Your Data</h2>
              <ul className="list-disc pl-6 text-sm space-y-1">
                <li>Provide the site, branch finder, and customer support via chat.</li>
                <li>Arrange or complete in-branch services and keep proper records.</li>
                <li>Meet legal duties (e.g., identity checks and record-keeping required by law).</li>
                <li>Keep the site safe, prevent fraud or abuse, and improve performance.</li>
                <li>Send updates or offers with your consent (you can opt out any time).</li>
              </ul>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">5) Legal Bases</h2>
              <p className="text-sm">
                We process data based on your consent, to perform requested services, to comply with
                legal obligations (including AMLA and BSP rules), and for our legitimate interests such as
                service improvement and security, balanced with your rights.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">6) Cookies & Similar Tools</h2>
              <p className="text-sm">
                Small files may be stored on your device to run the site, remember preferences, and
                measure performance. You can manage cookies in your browser. Turning off certain cookies
                may affect site features.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">7) Live Chat & Communications</h2>
              <p className="text-sm">
                Chat messages may be recorded to help resolve inquiries and improve service. We may
                contact you by email, SMS, or phone for follow-ups. Chat does not create a pawn contract—
                official records are issued in-branch.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">8) Sharing & Service Providers</h2>
              <p className="text-sm">
                We use trusted providers (e.g., website hosting, security, maps, messaging). They process
                data under our instructions and safeguards. We do not sell your personal data. We may also
                share information when required by law or to protect people, property, or our rights.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">9) Transfers Outside the Philippines</h2>
              <p className="text-sm">
                Some providers may store or process data in other countries. We take reasonable steps to
                ensure protection comparable to Philippine standards and use appropriate contractual or
                organizational safeguards.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">10) Retention</h2>
              <p className="text-sm">
                We keep data only as long as needed for the purposes above, for periods required by law
                (e.g., regulated record-keeping), and to establish or defend legal claims. When no longer
                needed, we securely delete or anonymize data.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">11) Security</h2>
              <p className="text-sm">
                We apply administrative, physical, and technical safeguards to protect personal data.
                No method is perfect, but we work to prevent unauthorized access, loss, or misuse and
                regularly review our measures.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">12) Your Privacy Rights</h2>
              <ul className="list-disc pl-6 text-sm space-y-1">
                <li>To be informed and to access your data.</li>
                <li>To correct inaccurate or incomplete data.</li>
                <li>To object to processing in certain cases.</li>
                <li>To block or delete data when allowed by law.</li>
                <li>To withdraw consent (affects future processing).</li>
                <li>To lodge a complaint with the National Privacy Commission (NPC).</li>
              </ul>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">13) Children’s Privacy</h2>
              <p className="text-sm">
                Our services are intended for adults. If we learn we collected data from a minor without
                proper authorization, we will take steps to delete it or obtain consent as required.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-semibold mb-2">14) Marketing Choices</h2>
              <p className="text-sm">
                You can opt out of marketing messages anytime using the link provided or by contacting us.
                Transactional or service-related notices may still be sent.
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
                For requests or complaints, please contact our Data Protection Officer (DPO):<br />
                <span className="font-medium">Email:</span> dpo@magispawnshop.com<br />
                <span className="font-medium">Address:</span> [Your Registered Business Address]<br />
                <span className="font-medium">Phone:</span> [Your Contact Number]
              </p>
              <p className="text-xs text-gray-600 mt-3">
                You may also contact the National Privacy Commission at <em>privacy.gov.ph</em> for concerns.
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
                className="px-6 py-2 rounded-full bg-yellow-500 text-black font-semibold hover:bg-yellow-600 transition"
              >
                Contact Us
              </Link>
              <Link
                to="/branches"
                className="px-6 py-2 rounded-full bg-black text-yellow-500 font-semibold hover:bg-gray-800 transition"
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
