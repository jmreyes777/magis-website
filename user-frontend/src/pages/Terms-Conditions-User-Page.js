// src/pages/Terms-Conditions-User-Page.jsx
import React, { useEffect, useState } from "react";
import Footer from "../components/Footer-User-Component";
import { Link } from "react-router-dom";

function Terms() {
  const [showPawnTerms, setShowPawnTerms] = useState(false);

  // prevent background scroll when modal is open
  useEffect(() => {
    if (showPawnTerms) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev || "";
      };
    }
  }, [showPawnTerms]);

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
          <h1 className="text-3xl md:text-4xl font-bold mb-2">Terms &amp; Conditions</h1>
          <p className="text-sm md:text-base opacity-90">Last updated: {lastUpdated}</p>
        </div>
      </section>

      <main className="flex-grow">
        {/* Intro & Acceptance */}
        <section className="py-10 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <p className="text-sm text-gray-600 mb-4">
              These Terms &amp; Conditions (“Terms”) govern your use of our website,
              branch finder, and live chat. By using our site, you agree to these Terms.
              For pawn transactions, Philippine law applies including BSP pawnshop
              regulations, the Anti-Money Laundering Act (AMLA), the Anti-Fencing Law,
              and the Data Privacy Act of 2012 (RA 10173). This page is a concise
              summary—retain a copy for your records.
            </p>
          </div>
        </section>

        {/* =========================
            Section 1: Website Usage
           ========================= */}
        <section id="website-usage" className="py-8 bg-gray-50">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-2xl font-bold mb-4">Website Usage</h2>
            <ul className="list-disc pl-6 space-y-3 text-gray-800">
              <li>
                <strong>Acceptance &amp; Scope.</strong> Using the site means you accept these Terms.
                Our website and chat provide information and assistance; actual pawn transactions
                are completed in-branch with official documents.
              </li>
              <li>
                <strong>Key Definitions.</strong> Terms such as pawn, pledge, pawn ticket, redemption,
                renewal, auction, and service fees follow their ordinary regulatory meanings.
              </li>
              <li>
                <strong>Branch Info &amp; Maps.</strong> Locations, hours, directions, and availability
                are indicative and may change; verify with the branch before visiting.
              </li>
              <li>
                <strong>Live Chat.</strong> Used for inquiries/support. Messages may be recorded.
                Chat does not create, amend, or replace any pawn contract or ticket.
              </li>
              <li>
                <strong>Privacy (RA 10173).</strong> We collect limited data (e.g., contact details,
                chat logs, device information) to operate the site and chat. You have data subject
                rights. See our <Link to="/privacy-policy" className="underline">Privacy Policy</Link>
                or contact our DPO for requests.
              </li>
              <li>
                <strong>Cookies &amp; Local Storage.</strong> Used for basic functionality and to
                improve the service. You can manage preferences via your browser settings.
              </li>
              <li>
                <strong>Electronic Communications.</strong> We may contact you via email, SMS,
                or chat regarding your inquiries. Official pawn records are the branch-issued documents.
              </li>
              <li>
                <strong>Third-Party Services.</strong> Services such as maps, hosting, analytics,
                and security are provided by third parties and subject to their terms.
              </li>
              <li>
                <strong>Accounts &amp; Access (Staff).</strong> Authorized personnel must keep
                credentials secure; misuse may result in suspension.
              </li>
              <li>
                <strong>Security &amp; Fair Use.</strong> Use the site lawfully—no abuse, spamming,
                scraping, reverse engineering, or service interference.
              </li>
              <li>
                <strong>Service Availability &amp; Changes.</strong> Features may change and maintenance
                or outages can occur without notice.
              </li>
              <li>
                <strong>Intellectual Property.</strong> Site content, design, and branding belong to us
                and may be used only for their intended purpose.
              </li>
              <li>
                <strong>Disclaimers &amp; Liability Limits.</strong> The site is provided “as is.”
                To the extent allowed by Philippine law, liability is limited.
              </li>
              <li>
                <strong>Governing Law &amp; Updates.</strong> Philippine law governs. We may update
                these Terms and will post changes here.
              </li>
            </ul>
          </div>
        </section>

        {/* =========================
            Section 2: Pawning (Renewal + Redemption)
           ========================= */}
        <section id="pawning" className="py-8 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-2xl font-bold mb-4">
              Pawning (Renewal &amp; Redemption)
            </h2>

            <div className="space-y-6">
              <div>
                <h3 className="font-semibold mb-2 flex items-center gap-3">
                  General Terms
                  <button
                    type="button"
                    className="text-xs md:text-sm underline text-yellow-700 hover:text-yellow-600"
                    onClick={() => setShowPawnTerms(true)}
                  >
                    See full terms
                  </button>
                </h3>
                <ul className="list-disc pl-6 space-y-3 text-gray-800">
                  <li>
                    <strong>Eligibility.</strong> You must be of legal age and present a valid
                    government-issued ID to enter into a pawn transaction.
                  </li>
                  <li>
                    <strong>Customer Promises.</strong> You confirm that all information and items
                    you present are true, accurate, lawful, and rightfully yours to pawn.
                  </li>
                  <li>
                    <strong>Interest Rates.</strong> Posted at branches and reflected
                    on the pawn ticket; online examples are illustrative only.
                  </li>
                  <li>
                    <strong>Item Care &amp; Risk.</strong> We use reasonable care in storage while
                    pledged items are in custody. Responsibility and limits are as permitted by law
                    and as specified on the pawn ticket.
                  </li>
                  <li>
                    <strong>Prohibited/Regulated Items.</strong> We do not accept stolen, counterfeit,
                    illegal, or otherwise restricted items.
                  </li>
                  <li>
                    <strong>AMLA &amp; KYC.</strong> We verify identity, may request supporting
                    documents, and may refuse or suspend transactions to comply with AMLA.
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Redemption</h3>
                <ul className="list-disc pl-6 space-y-3 text-gray-800">
                  <li>
                    <strong>Documents.</strong> Present the pawn ticket and a valid ID of
                    the pawner. Authorized representatives must present an authorization letter, their
                    valid ID, and the original owner's pawn ticket (subject to verification).
                  </li>
                  <li>
                    <strong>Payment.</strong> Pay the principal plus charges as stated on your ticket,
                    subject to applicable periods and any grace/recovery periods under BSP rules.
                  </li>
                  <li>
                    <strong>Lost Ticket.</strong> Report immediately. Replacement/release will require
                    an affidavit of loss (available in-branch) and fees; transactions remain subject to verification.
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Renewal</h3>
                <ul className="list-disc pl-6 space-y-3 text-gray-800">
                  <li>
                    <strong>When &amp; Where.</strong> Renew on or before maturity at any Magis Pawnshop branch.
                  </li>
                  <li>
                    <strong>Requirements.</strong> Present the original pawn ticket and a valid ID,
                    then pay the charges stated on your ticket to renew the term.
                  </li>
                  <li>
                    <strong>Ticket Update.</strong> You’ll receive a renewed ticket reflecting the new
                    term and charges.
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="font-semibold mb-2">Unredeemed Items &amp; Auction</h3>
                <ul className="list-disc pl-6 space-y-3 text-gray-800">
                  <li>
                    Items not redeemed within the applicable periods may be disposed of (e.g., public
                    auction) per BSP rules and notice procedures stated on your pawn ticket.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* =========================
            Section 3: Jewelry Sales (Pricing & Returns)
           ========================= */}
        <section id="jewelry-sales" className="py-8 bg-gray-50">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-2xl font-bold mb-4">
              Jewelry Sales (Pricing &amp; Returns)
            </h2>
            <ul className="list-disc pl-6 space-y-3 text-gray-800">
              <li>
                <strong>In-Branch Pricing.</strong> Prices are set and finalized in-branch. Any
                prices or photos shown online are indicative; the price tag and receipt issued by
                the branch prevail.
              </li>
              <li>
                <strong>Availability.</strong> Selection varies by branch and may change without
                prior notice. Items cannot be guaranteed reserved unless stated by the branch.
              </li>
              <li>
                <strong>Receipts.</strong> Keep your official receipt and any product tags or
                certificates provided at the time of sale.
              </li>
              <li>
                <strong>Returns/Exchanges.</strong> Returns or exchanges follow our posted branch
                policy and applicable law. For hygiene/safety, certain items (e.g., earrings) may be
                non-returnable unless defective as provided by law.
              </li>
              <li>
                <strong>Inspection.</strong> Please inspect your item(s) before purchase. If you
                believe an item is defective, promptly bring it (with receipt) to the issuing
                branch for assessment per policy.
              </li>
            </ul>
          </div>
        </section>

        {/* =========================
            Section 4: For More Information (Contact)
           ========================= */}
        <section id="contact-info" className="py-10 bg-white">
          <div className="container mx-auto px-4 max-w-4xl">
            <h2 className="text-2xl font-bold mb-4">For More Information</h2>
            <p className="text-gray-700 mb-6">
              Need help or want to review our policies in full? Contact us or visit a branch.
            </p>
            <div className="flex flex-wrap items-center gap-3">
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

            <p className="text-xs text-gray-500 mt-6">
              This summary is for convenience only. In case of any difference, the{" "}
              <strong>pawn ticket</strong>, posted in-branch policies, and applicable laws/regulations
              prevail.
            </p>
          </div>
        </section>
      </main>

      {/* Footer */}
      <Footer />

      {/* =========================
          Modal: Full Pawning Terms  (SCROLLABLE)
          ========================= */}
      {showPawnTerms && (
        <div className="fixed inset-0 z-[10050] grid place-items-center">
          {/* Backdrop */}
          <button
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowPawnTerms(false)}
            aria-label="Close modal backdrop"
          />
          {/* Dialog */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pawn-terms-title"
            className="relative w-[92%] max-w-3xl max-h-[90svh] bg-white rounded-lg shadow-xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b shrink-0">
              <h4 id="pawn-terms-title" className="text-lg font-bold">
                Full Pawning Terms &amp; Conditions
              </h4>
              <button
                className="text-2xl leading-none px-2 -m-2 hover:opacity-80"
                aria-label="Close modal"
                onClick={() => setShowPawnTerms(false)}
              >
                ×
              </button>
            </div>

            {/* Body (scrollable) */}
            <div
              className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6"
              style={{
                WebkitOverflowScrolling: "touch",
                scrollbarGutter: "stable",
              }}
            >
              <ol className="list-decimal pl-6 space-y-3 text-sm text-gray-800">
                <li>The pawner hereby accepts the pawnshop&apos;s appraisal as proper.</li>
                <li>
                  The pawnshop hereby agrees not to collect advance interest for a period of more
                  than one (1) year.
                </li>
                <li>
                  This loan is renewable for such amount and period as may be agreed upon between
                  the pawnshop and the pawner, subject to the same requirements for a new loan.
                </li>
                <li>
                  Upon maturity of this loan as indicated on the face of this pawn ticket, the
                  pawner has ninety (90) days from maturity date within which to redeem the pawn by
                  paying the principal loan plus the interest that shall have accrued thereon.
                </li>
                <li>
                  The amount of interest due and payable after the maturity date of the loan up to
                  the redemption period shall be computed upon redemption at the rate of interest
                  provided above based on the sum of the principal loan and interest earned as of
                  the date of maturity. Any additional penalty and/or interest shall also be
                  computed in the same manner.
                </li>
                <li>
                  The pawnshop shall notify the pawner of any change in its business address/location.
                </li>
                <li>
                  The pawner and the pawnshop agree that the notice of auction sales shall be
                  delivered via [ ] e-mail, [ ] SMS, [ ] registered mail or courier at _________
                  (check the agreed mode and indicate the address/number as appropriate). In case
                  no mode of notification is agreed upon, the default shall be via ordinary mail.
                  The pawnshop shall have the right to sell or dispose of the pawn in public
                  auction if the pawner fails to redeem the pawn within the ninety (90)-day grace
                  period. The pawnshop shall send the reminder on or before the expiration of the
                  ninety (90)-day grace period.
                </li>
                <li>
                  The pawner shall advise the pawnshop of any change of address, mobile phone
                  number, or e-mail address.
                </li>
                <li>
                  This ticket shall be surrendered at maturity date upon payment of the loan. In
                  case of loss or destruction of this ticket, the pawner hereby undertakes to
                  personally present an affidavit to the pawnshop before the redemption period
                  expires. The pawnshop has two (2) days to decide whether to accept (1) the
                  affidavit in place of the original pawn ticket; or (2) to issue a substitute pawn
                  ticket, thereby cancelling the original.
                </li>
                <li>
                  In case of pre-payment of this loan by pawner, the interest collected in advance
                  shall accrue in full to the pawnshop.
                </li>
                <li>
                  The pawner shall not be entitled to the excess of the public auction sale price
                  over the amount of principal, interest and service fee; neither shall the
                  pawnshop be entitled to recover the deficiency from the pawner.
                </li>
                <li>
                  The pawner declares, under the penalty of the Anti-Fencing Law, that he/she is
                  the owner of the property subject of this contract.
                </li>
                <li>
                  The pawnee shall not be liable for the loss or damage of the article pawned due
                  to fortuitous events or force majeure. When the loss is due to the fault and/or
                  negligence of the pawnee, the amount of its liability, if any, shall be limited
                  to the appraised value appearing on the face hereof.
                </li>
                <li>
                  The pawner hereby agrees not to assign, sell or in any other way alienate the
                  pawn securing this loan as evidenced by the pawn ticket without prior written
                  consent of the pawnshop and subject to the terms and conditions of this contract.
                </li>
                <li>
                  In case this loan is not paid on the maturity date, the pawner hereby agrees to
                  pay, in addition to accrued interest, 2% per month of the principal as liquidated
                  damages. For purposes of computing the amount of liquidated damages, a fraction
                  of a month shall be considered as one (1) full month.
                </li>
                <li>The authorized representative must present valid identification papers.</li>
                <li>
                  Venue of all judicial/administrative cases or proceedings and other legal
                  incidents arising out of or in connection with this contract shall solely and
                  exclusively be brought before appropriate courts, departments, offices or
                  agencies of the government situated in Angeles City, Pampanga.
                </li>
              </ol>
            </div>

            {/* Footer */}
            <div className="p-4 border-t text-right shrink-0">
              <button
                className="px-4 py-2 rounded bg-black text-white hover:bg-gray-800"
                onClick={() => setShowPawnTerms(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Terms;
