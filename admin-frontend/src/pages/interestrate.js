//magis-project/admin-frontend/src/pages/interestrate.js

import React, { useState } from "react";

const InterestRateTable = () => {
  const [interestRates, setInterestRates] = useState([
    { id: 1, range: "1-10 Days", rate: 1 },
    { id: 2, range: "11-20 Days", rate: 1.5 },
    { id: 3, range: "21-30 Days", rate: 2 },
    { id: 4, range: "31-40 Days", rate: 2.5 },
    { id: 5, range: "41-50 Days", rate: 3 },
  ]);

  const [newRange, setNewRange] = useState("");
  const [newRate, setNewRate] = useState("");

  // Compute Total Interest for Display
  const cumulativeInterestRates = interestRates.map((item, index) => {
    const totalRate =
      index === 0
        ? item.rate
        : interestRates.slice(0, index + 1).reduce((acc, val) => acc + val.rate, 0);
    return { ...item, totalRate };
  });

  // Add New Interest Rate
  const addNewRate = () => {
    if (!newRange || !newRate) return alert("Please enter valid values!");
    setInterestRates([...interestRates, { id: Date.now(), range: newRange, rate: parseFloat(newRate) }]);
    setNewRange("");
    setNewRate("");
  };

  return (
    <div style={{ maxWidth: "600px", margin: "auto", textAlign: "center", fontFamily: "Arial, sans-serif" }}>
      <h2>💰 **Flexible & Competitive Interest Rates**</h2>
      <p style={{ fontSize: "14px", color: "gray" }}>
        Our rates are structured for **fairness & transparency**. Interest is **cumulative** over time, ensuring you always know what you're paying.
      </p>

      <table border="1" style={{ width: "100%", marginTop: "10px", borderCollapse: "collapse", textAlign: "center" }}>
        <thead>
          <tr style={{ backgroundColor: "#f8f8f8" }}>
            <th>📅 Time Range</th>
            <th>💲 Interest Rate (%)</th>
            <th>📈 Total Interest (%)</th>
          </tr>
        </thead>
        <tbody>
          {cumulativeInterestRates.map((item) => (
            <tr key={item.id}>
              <td><strong>{item.range}</strong></td>
              <td style={{ color: "green" }}>+{item.rate}%</td>
              <td style={{ color: "blue" }}><strong>{item.totalRate}%</strong></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: "20px" }}>➕ Add New Interest Rate</h3>
      <input
        type="text"
        placeholder="Time Range (e.g., 51-60 Days)"
        value={newRange}
        onChange={(e) => setNewRange(e.target.value)}
        style={{ padding: "5px", marginRight: "10px" }}
      />
      <input
        type="number"
        placeholder="Interest Rate (%)"
        value={newRate}
        onChange={(e) => setNewRate(e.target.value)}
        style={{ padding: "5px", width: "80px" }}
      />
      <button onClick={addNewRate} style={{ marginLeft: "10px", cursor: "pointer", padding: "5px 10px", backgroundColor: "blue", color: "white", border: "none" }}>
        Add
      </button>
    </div>
  );
};

export default InterestRateTable;