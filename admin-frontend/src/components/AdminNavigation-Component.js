import React, { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthContext from '../context/AuthContext';
import { CHAT_ENABLED } from '../config/features';

// CHAT-PARK: the nav list as a pure helper so the parked layout is testable
// without rendering. `false` hides the Chat Dashboard and surfaces Analytics
// (which has no other entry point when chats are hidden).
export function getNavItems(chatEnabled) {
  const items = [
    { path: '/admin/audit', label: 'Activity History', roles: ['branchadmin', 'superadmin'] },
    { path: '/admin/observability', label: 'Observability', roles: ['superadmin'] },
    { path: '/admin/branches', label: 'Branch Management', roles: ['superadmin'] },
  ];
  return chatEnabled
    ? [
        { path: '/admin/chats', label: 'Chat Dashboard', roles: ['branchadmin'] },
        ...items,
      ]
    : [
        items[0],
        { path: '/admin/analytics', label: 'Analytics', roles: ['branchadmin'] },
        ...items.slice(1),
      ];
}

const AdminNavigation = ({ currentPage }) => {
  const navigate = useNavigate();
  const { userRole } = useContext(AuthContext);

  const navItems = getNavItems(CHAT_ENABLED);

  const filteredNavItems = navItems.filter(item => item.roles.includes(userRole));

  return (
    <nav className="admin-navigation">
      <div className="flex gap-4 items-center">
        {filteredNavItems.map((item) => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`nav-link ${currentPage === item.path ? 'nav-link-active' : ''}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
};

export default AdminNavigation;
