import React, { useState, useEffect, useContext } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import MetricsCard from "../components/MetricsCard-Component";
import AnalyticsTable from "../components/AnalyticsTable-Component";
import DateRangePicker from "../components/DateRangePicker-Component";
import AdminNavigation from "../components/AdminNavigation-Component";
import AuthContext from "../context/AuthContext";

function BranchAdminAnalytics() {
  const { userRole, adminEmail, handleLogout } = useContext(AuthContext);
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 6); // 6 months back instead of 30 days
    return date;
  });
  const [endDate, setEndDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [messageVolumeData, setMessageVolumeData] = useState(null);
  const [responseTimeData, setResponseTimeData] = useState(null);
  const [conversationSummaryData, setConversationSummaryData] = useState(null);
  const [branchPerformanceData, setBranchPerformanceData] = useState(null);
  const [error, setError] = useState(null);

  const fetchAnalytics = async () => {
    setLoading(true);
    setError(null);
    
    console.log("[FRONTEND] Starting analytics fetch");
    console.log("[FRONTEND] User role:", userRole);
    console.log("[FRONTEND] Date range:", { startDate, endDate });
    
    try {
      const token = sessionStorage.getItem("branchAdminToken") || sessionStorage.getItem("superAdminToken");
      console.log("[FRONTEND] Token found:", !!token);
      
      const headers = {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      };

      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];

      // Fetch message volume
      console.log("[FRONTEND] Fetching message volume...");
      const volumeRes = await fetch(
        `${process.env.REACT_APP_API_URL}/api/analytics/message-volume?startDate=${startDateStr}&endDate=${endDateStr}`,
        { headers }
      );
      console.log("[FRONTEND] Message volume response status:", volumeRes.status);
      if (volumeRes.ok) {
        const volumeData = await volumeRes.json();
        console.log("[FRONTEND] Message volume data:", volumeData);
        setMessageVolumeData(volumeData);
      } else {
        const errorText = await volumeRes.text();
        console.error("[FRONTEND] Message volume error:", errorText);
      }

      // Fetch response time
      console.log("[FRONTEND] Fetching response time...");
      const responseRes = await fetch(
        `${process.env.REACT_APP_API_URL}/api/analytics/response-time?startDate=${startDateStr}&endDate=${endDateStr}`,
        { headers }
      );
      console.log("[FRONTEND] Response time response status:", responseRes.status);
      if (responseRes.ok) {
        const responseData = await responseRes.json();
        console.log("[FRONTEND] Response time data:", responseData);
        setResponseTimeData(responseData);
      } else {
        const errorText = await responseRes.text();
        console.error("[FRONTEND] Response time error:", errorText);
      }

      // Fetch conversation summary
      console.log("[FRONTEND] Fetching conversation summary...");
      const summaryRes = await fetch(
        `${process.env.REACT_APP_API_URL}/api/analytics/conversation-summary?startDate=${startDateStr}&endDate=${endDateStr}`,
        { headers }
      );
      console.log("[FRONTEND] Conversation summary response status:", summaryRes.status);
      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        console.log("[FRONTEND] Conversation summary data:", summaryData);
        setConversationSummaryData(summaryData);
      } else {
        const errorText = await summaryRes.text();
        console.error("[FRONTEND] Conversation summary error:", errorText);
      }

      // Fetch branch performance (superadmin only)
      if (userRole === "superadmin") {
        const performanceRes = await fetch(
          `${process.env.REACT_APP_API_URL}/api/analytics/branch-performance?startDate=${startDateStr}&endDate=${endDateStr}`,
          { headers }
        );
        if (performanceRes.ok) {
          const performanceData = await performanceRes.json();
          setBranchPerformanceData(performanceData);
        }
      }
    } catch (err) {
      console.error("[ANALYTICS] Error fetching analytics:", err);
      setError("Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [startDate, endDate, userRole]);

  // Calculate operational insights
  const getResponseStatus = (avgTime) => {
    if (avgTime < 5) return { status: 'On Track', color: 'text-green-600', bgColor: 'bg-green-100', icon: '✓' };
    if (avgTime < 15) return { status: 'Watch', color: 'text-yellow-600', bgColor: 'bg-yellow-100', icon: '⚠' };
    return { status: 'Needs Attention', color: 'text-red-600', bgColor: 'bg-red-100', icon: '!' };
  };

  const getConversationPressure = (totalConversations, avgMessages) => {
    const pressureScore = totalConversations * avgMessages;
    if (pressureScore > 500) return { status: 'High Pressure', color: 'text-red-600', bgColor: 'bg-red-100' };
    if (pressureScore > 200) return { status: 'Moderate', color: 'text-yellow-600', bgColor: 'bg-yellow-100' };
    return { status: 'Normal', color: 'text-green-600', bgColor: 'bg-green-100' };
  };

  const getAttentionItems = () => {
    const items = [];
    
    if (responseTimeData) {
      const avgTime = responseTimeData.averageResponseTime;
      if (avgTime > 30) {
        items.push({
          type: 'Service Risk',
          message: `Response times averaging ${avgTime} min - customers waiting too long`,
          priority: 'high'
        });
      }
      const slowResponses = responseTimeData.responseTimeDistribution?.over30 || 0;
      if (slowResponses > 5) {
        items.push({
          type: 'Bottleneck',
          message: `${slowResponses} delayed responses over 30 min`,
          priority: 'medium'
        });
      }
    }
    
    if (conversationSummaryData) {
      const unresolvedRatio = conversationSummaryData.conversationsWithMedia / conversationSummaryData.totalConversations;
      if (unresolvedRatio > 0.3) {
        items.push({
          type: 'Backlog',
          message: 'High rate of media-heavy conversations may indicate complex cases',
          priority: 'low'
        });
      }
    }
    
    if (messageVolumeData && messageVolumeData.volumeByDate.length > 0) {
      const recentVolume = messageVolumeData.volumeByDate.slice(-3).reduce((sum, d) => sum + d.count, 0);
      const avgVolume = messageVolumeData.averageDaily || 1;
      if (recentVolume > avgVolume * 2) {
        items.push({
          type: 'Volume Spike',
          message: 'Recent message volume significantly above average',
          priority: 'medium'
        });
      }
    }
    
    return items;
  };

  const responseStatus = getResponseStatus(responseTimeData?.averageResponseTime || 0);
  const pressureStatus = getConversationPressure(conversationSummaryData?.totalConversations || 0, conversationSummaryData?.avgMessagesPerConversation || 0);
  const attentionItems = getAttentionItems();

  const conversationColumns = [
    { key: 'guestName', label: 'Guest Name' },
    { key: 'messageCount', label: 'Messages' },
    { key: 'duration', label: 'Duration (min)', render: (value) => `${value} min` },
    { key: 'hasMedia', label: 'Has Media', render: (value) => value ? 'Yes' : 'No' },
  ];

  const branchPerformanceColumns = [
    { key: 'branchEmail', label: 'Branch Email' },
    { key: 'messageCount', label: 'Messages' },
    { key: 'uniqueConversations', label: 'Conversations' },
    { key: 'avgMessagesPerConversation', label: 'Avg Messages/Conv' },
  ];

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="w-full bg-gray-800 text-white p-4 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold">Branch Analytics Dashboard</h1>
          <AdminNavigation currentPage="/admin/analytics" />
        </div>
        <button
          onClick={handleLogout}
          className="btn btn-primary"
        >
          Logout
        </button>
      </div>

      <div className="flex flex-row flex-grow bg-gray-100">
        {/* Main Content */}
        <div className="w-full p-6 overflow-y-auto">
          {/* Date Range Picker */}
          <div className="mb-6">
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onStartDateChange={setStartDate}
              onEndDateChange={setEndDate}
              presets={['week', 'month', 'quarter']}
            />
          </div>

          {error && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-center text-gray-500 py-8">Loading analytics...</div>
          ) : (
            <>
              {/* What Needs Attention Section */}
              {attentionItems.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                  <h3 className="text-lg font-semibold text-red-800 mb-3 flex items-center gap-2">
                    <span className="text-xl">⚠</span>
                    What Needs Attention
                  </h3>
                  <div className="space-y-2">
                    {attentionItems.map((item, index) => (
                      <div key={index} className="flex items-start gap-3 bg-white p-3 rounded border border-red-100">
                        <span className={`px-2 py-1 text-xs font-semibold rounded ${
                          item.priority === 'high' ? 'bg-red-100 text-red-800' :
                          item.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                          'bg-blue-100 text-blue-800'
                        }`}>
                          {item.type}
                        </span>
                        <p className="text-sm text-gray-700">{item.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Enhanced Metrics Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="admin-card metrics-card-enhanced">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-600">Total Messages</p>
                    <span className={`px-2 py-1 text-xs font-semibold rounded ${pressureStatus.bgColor} ${pressureStatus.color}`}>
                      {pressureStatus.status}
                    </span>
                  </div>
                  <p className="text-3xl font-bold text-gray-900">{messageVolumeData?.totalMessages || 0}</p>
                  <p className="text-xs text-gray-500 mt-2">
                    Avg {messageVolumeData?.averageDaily || 0} messages/day
                  </p>
                </div>

                <div className="admin-card metrics-card-enhanced">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-600">Total Conversations</p>
                    <span className="px-2 py-1 text-xs font-semibold rounded bg-blue-100 text-blue-800">
                      Active
                    </span>
                  </div>
                  <p className="text-3xl font-bold text-gray-900">{conversationSummaryData?.totalConversations || 0}</p>
                  <p className="text-xs text-gray-500 mt-2">
                    {conversationSummaryData?.avgConversationDuration || 0} min avg duration
                  </p>
                </div>

                <div className="admin-card metrics-card-enhanced">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-600">Avg Response Time</p>
                    <span className={`px-2 py-1 text-xs font-semibold rounded ${responseStatus.bgColor} ${responseStatus.color}`}>
                      {responseStatus.icon} {responseStatus.status}
                    </span>
                  </div>
                  <p className="text-3xl font-bold text-gray-900">{responseTimeData?.averageResponseTime || 0} min</p>
                  <p className="text-xs text-gray-500 mt-2">
                    Target: &lt; 5 min
                  </p>
                </div>

                <div className="admin-card metrics-card-enhanced">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-600">Avg Messages/Conversation</p>
                    <span className="px-2 py-1 text-xs font-semibold rounded bg-gray-100 text-gray-800">
                      Volume
                    </span>
                  </div>
                  <p className="text-3xl font-bold text-gray-900">{conversationSummaryData?.avgMessagesPerConversation || 0}</p>
                  <p className="text-xs text-gray-500 mt-2">
                    {conversationSummaryData?.conversationsWithMedia || 0} with media
                  </p>
                </div>
              </div>

              {/* Operational Insight Panels */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                {/* Current Workload */}
                <div className="admin-card">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <span className="text-lg">📊</span>
                    Current Workload
                  </h4>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Active Conversations</span>
                      <span className="text-lg font-bold text-gray-900">{conversationSummaryData?.totalConversations || 0}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Avg Messages/Conversation</span>
                      <span className="text-lg font-bold text-gray-900">{conversationSummaryData?.avgMessagesPerConversation || 0}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Media-Heavy Cases</span>
                      <span className="text-lg font-bold text-gray-900">{conversationSummaryData?.conversationsWithMedia || 0}</span>
                    </div>
                  </div>
                </div>

                {/* Service Risk Indicators */}
                <div className="admin-card">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <span className="text-lg">⚡</span>
                    Service Risk Indicators
                  </h4>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Delayed Responses</span>
                      <span className={`text-lg font-bold ${responseTimeData?.responseTimeDistribution?.over30 > 5 ? 'text-red-600' : 'text-gray-900'}`}>
                        {responseTimeData?.responseTimeDistribution?.over30 || 0}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Slow Response Rate</span>
                      <span className="text-lg font-bold text-gray-900">
                        {responseTimeData?.totalConversations > 0 
                          ? Math.round((responseTimeData?.responseTimeDistribution?.over30 / responseTimeData?.totalConversations) * 100) 
                          : 0}%
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Response Status</span>
                      <span className={`text-sm font-semibold px-2 py-1 rounded ${responseStatus.bgColor} ${responseStatus.color}`}>
                        {responseStatus.status}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Service Pressure */}
                <div className="admin-card">
                  <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <span className="text-lg">📈</span>
                    Service Pressure
                  </h4>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Daily Average</span>
                      <span className="text-lg font-bold text-gray-900">{messageVolumeData?.averageDaily || 0}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Peak Volume</span>
                      <span className="text-lg font-bold text-gray-900">
                        {messageVolumeData?.volumeByDate?.length > 0 
                          ? Math.max(...messageVolumeData.volumeByDate.map(d => d.count)) 
                          : 0}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-600">Pressure Level</span>
                      <span className={`text-sm font-semibold px-2 py-1 rounded ${pressureStatus.bgColor} ${pressureStatus.color}`}>
                        {pressureStatus.status}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Enhanced Message Volume Chart */}
              <div className="admin-card mb-6">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Message Volume Over Time</h3>
                    <p className="text-sm text-gray-600">Track customer conversation patterns and identify peak service periods</p>
                  </div>
                  {messageVolumeData?.averageDaily && (
                    <div className="text-right">
                      <p className="text-xs text-gray-500">Daily Average</p>
                      <p className="text-lg font-bold text-gray-900">{messageVolumeData.averageDaily}</p>
                    </div>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={messageVolumeData?.volumeByDate || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="date" stroke="#6b7280" fontSize={12} />
                    <YAxis stroke="#6b7280" fontSize={12} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                      itemStyle={{ color: '#111827' }}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="count" stroke="#f1c40f" strokeWidth={2} name="Messages" dot={{ fill: '#f1c40f' }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Enhanced Response Time Distribution */}
              <div className="admin-card mb-6">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Response Time Distribution</h3>
                    <p className="text-sm text-gray-600">Monitor service responsiveness and identify response bottlenecks</p>
                  </div>
                  {responseTimeData && (
                    <div className="text-right">
                      <p className="text-xs text-gray-500">Median Response</p>
                      <p className="text-lg font-bold text-gray-900">{responseTimeData.medianResponseTime} min</p>
                    </div>
                  )}
                </div>
                {responseTimeData && (
                  <div className="grid grid-cols-4 gap-4">
                    <div className="text-center p-4 bg-green-50 rounded-lg border border-green-200">
                      <div className="text-3xl font-bold text-green-600">
                        {responseTimeData.responseTimeDistribution?.under5 || 0}
                      </div>
                      <div className="text-sm font-medium text-green-800 mt-1">&lt; 5 min</div>
                      <div className="text-xs text-green-600 mt-1">Excellent</div>
                    </div>
                    <div className="text-center p-4 bg-yellow-50 rounded-lg border border-yellow-200">
                      <div className="text-3xl font-bold text-yellow-600">
                        {responseTimeData.responseTimeDistribution?.under15 || 0}
                      </div>
                      <div className="text-sm font-medium text-yellow-800 mt-1">5-15 min</div>
                      <div className="text-xs text-yellow-600 mt-1">Acceptable</div>
                    </div>
                    <div className="text-center p-4 bg-orange-50 rounded-lg border border-orange-200">
                      <div className="text-3xl font-bold text-orange-600">
                        {responseTimeData.responseTimeDistribution?.under30 || 0}
                      </div>
                      <div className="text-sm font-medium text-orange-800 mt-1">15-30 min</div>
                      <div className="text-xs text-orange-600 mt-1">Slow</div>
                    </div>
                    <div className="text-center p-4 bg-red-50 rounded-lg border border-red-200">
                      <div className="text-3xl font-bold text-red-600">
                        {responseTimeData.responseTimeDistribution?.over30 || 0}
                      </div>
                      <div className="text-sm font-medium text-red-800 mt-1">&gt; 30 min</div>
                      <div className="text-xs text-red-600 mt-1">Critical</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Conversation Summary Table */}
              {conversationSummaryData && conversationSummaryData.conversations && (
                <div className="admin-card mb-6">
                  <h3 className="text-lg font-semibold mb-4">Conversation Details</h3>
                  <AnalyticsTable
                    columns={conversationColumns}
                    data={conversationSummaryData.conversations}
                    pageSize={10}
                  />
                </div>
              )}

              {/* Branch Performance Table (Superadmin only) */}
              {userRole === "superadmin" && branchPerformanceData && (
                <div className="admin-card mb-6">
                  <h3 className="text-lg font-semibold mb-4">Branch Performance Comparison</h3>
                  <AnalyticsTable
                    columns={branchPerformanceColumns}
                    data={branchPerformanceData.branchPerformance || []}
                    pageSize={10}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default BranchAdminAnalytics;
