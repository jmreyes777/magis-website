import React, { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthContext from '../context/AuthContext';

const AdminNavigation = ({ currentPage }) => {
  const navigate = useNavigate();
  const { userRole } = useContext(AuthContext);

  const navItems = [
    { path: '/admin/chats', label: 'Chat Dashboard', roles: ['branchadmin'] },
    { path: '/admin/audit', label: 'Audit Log', roles: ['branchadmin', 'superadmin'] },
    { path: '/admin/observability', label: 'Observability', roles: ['superadmin'] },
    { path: '/admin/branches', label: 'Branch Management', roles: ['superadmin'] },
  ];

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
