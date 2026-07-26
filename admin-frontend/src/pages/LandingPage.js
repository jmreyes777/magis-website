//magis-project/admin-frontend/src/pages/LandingPage.js

import React from "react";
import { Link } from "react-router-dom";
import AuthShell, { BTN_PRIMARY, BTN_OUTLINE } from "../components/AuthShell";

const LandingPage = () => {
  return (
    <AuthShell width="w-[26rem]">
      <h1 className="mb-1 text-center text-2xl font-bold text-slate-900">
        Welcome to the Magis Admin Portal
      </h1>
      <p className="mb-7 text-center text-sm text-slate-500">
        Please select your login interface to proceed:
      </p>

      <div className="flex flex-col gap-3">
        {/* Branch Login Button (unified Staff + Branch Admin) — the common path */}
        <Link to="/branch-admin-login" className="block no-underline">
          <button type="button" className={BTN_PRIMARY}>
            Branch Login
          </button>
        </Link>

        {/* Super Admin Login Button */}
        <Link to="/super-admin-login" className="block no-underline">
          <button type="button" className={BTN_OUTLINE}>
            Super Admin Login
          </button>
        </Link>
      </div>
    </AuthShell>
  );
};

export default LandingPage;