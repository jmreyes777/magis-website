//magis-project/admin-frontend/src/pages/LandingPage.js

import React from "react";
import { Link } from "react-router-dom";

const LandingPage = () => {
  return (
    <div style={{ textAlign: "center", marginTop: "50px" }}>
      <h1>Welcome to the Magis Admin Portal</h1>
      <p>Please select your login interface to proceed:</p>

      <div style={{ marginTop: "30px", display: "flex", justifyContent: "center", gap: "20px" }}>
        {/* Super Admin Login Button */}
        <Link to="/super-admin-login" style={{ textDecoration: "none" }}>
          <button
            style={{
              padding: "10px 20px",
              backgroundColor: "#4A90E2",
              color: "white",
              fontSize: "16px",
              border: "none",
              borderRadius: "5px",
              cursor: "pointer",
            }}
          >
            Super Admin Login
          </button>
        </Link>

        {/* Branch Login Button (unified Staff + Branch Admin) */}
        <Link to="/branch-admin-login" style={{ textDecoration: "none" }}>
          <button
            style={{
              padding: "10px 20px",
              backgroundColor: "#7ED321",
              color: "white",
              fontSize: "16px",
              border: "none",
              borderRadius: "5px",
              cursor: "pointer",
            }}
          >
            Branch Login
          </button>
        </Link>
      </div>
    </div>
  );
};

export default LandingPage;