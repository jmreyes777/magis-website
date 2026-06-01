import React from 'react';
import './Footer-User-Component.css'; // Keep the custom styles

function Footer() {
  // Define section data with unique links for each category
  const footerData = [
    {
      title: 'Company Information',
      links: [
        { name: 'About Us', url: '#' },
        { name: 'Careers', url: '#' },
      ],
    },
    {
      title: 'Customer Center',
      links: [
        { name: 'Contact Us', url: '#' },
        { name: 'FAQs', url: '#' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { name: 'Terms and Conditions', url: '#' },
        { name: 'Privacy Policy', url: '#' },
      ],
    },
    {
      title: 'Social Media',
      links: [
        { name: 'Facebook', url: '#' },
        { name: 'Instagram', url: '#' },
      ],
    },
  ];

  return (
    <footer className="bg-gray-900 text-white py-8">
      <div className="footer-columns max-w-screen-lg mx-auto grid grid-cols-1 md:grid-cols-4 gap-8 text-center md:text-left">
        {/* Dynamically render each section with its links */}
        {footerData.map((section, index) => (
          <div key={index} className="footer-column">
            <h4 className="text-lg font-semibold mb-2">{section.title}</h4>
            <ul className="space-y-1">
              {section.links.map((link, i) => (
                <li key={i}>
                  <a 
                    href={link.url} 
                    className="hover:text-yellow-400 transition-colors duration-300"
                    target="_blank" 
                    rel="noopener noreferrer" // Ensures security for external links
                    aria-label={`${link.name} link`}
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Footer Bottom Section */}
      <div className="footer-bottom mt-6 text-sm text-center text-gray-400">
        <p>&copy; 2024 Magis Gold & Gem Pawnshop & Jewelry. All rights reserved.</p>
        <p className="mt-2">
          Regulated by the Bangko Sentral ng Pilipinas |{' '}
          <a
            href="https://www.bsp.gov.ph"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-yellow-400"
            aria-label="Bangko Sentral ng Pilipinas website"
          >
            www.bsp.gov.ph
          </a>{' '}
          |{' '}
          <a
            href="mailto:consumeraffairs@bsp.gov.ph"
            className="hover:text-yellow-400"
            aria-label="Email to Consumer Affairs"
          >
            consumeraffairs@bsp.gov.ph
          </a>
        </p>
      </div>
    </footer>
  );
}

export default Footer;