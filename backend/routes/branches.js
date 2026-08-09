//magis-project/backend/routes/branches.js

const express = require('express');
const multer = require('multer');
const { db, storage, uploadToStorage } = require('../utils/firebase'); // Firebase utilities
const { FieldValue } = require('firebase-admin/firestore'); // v14: namespace API removed
const authenticateSuperAdmin = require('../middlewares/authenticateSuperAdmin'); // Super admin middleware
const authenticateBranchAdmin = require('../middlewares/authenticateBranchAdmin'); // Branch admin middleware
const { v4: uuidv4 } = require('uuid'); // For generating unique filenames
const router = express.Router();

// PERF2-1: read-through cache for the near-static, NON-SENSITIVE `branches`
// metadata (no credentials live here — those are in `branchAdmins`). The write
// routes below invalidate it, so the TTL is just a backstop. Fail-open: if
// Redis is down the helper transparently falls back to Firestore.
const { cached, invalidate, key } = require('../utils/cache');
const BRANCHES_TTL = Number(process.env.CACHE_BRANCHES_TTL || 300); // seconds
const branchesListKey = () => key('branches', 'list');
const branchDocKey = (id) => key('branches', 'doc', id);

// File storage setup using Multer
const storageMulter = multer.memoryStorage();
const upload = multer({
  storage: storageMulter,
  limits: {
    fieldSize: 10 * 1024 * 1024, // 10 MB field size limit
    fileSize: 5 * 1024 * 1024, // 5 MB file size limit
  },
});

// Middleware to verify super admin and branch admin roles
const verifyAdminRole = async (req, res, next) => {
  try {
    const authorizationHeader = req.headers.authorization;
    if (authorizationHeader?.startsWith('Bearer ')) {
      await authenticateSuperAdmin(req, res, next);
    } else {
      await authenticateBranchAdmin(req, res, next);
    }
  } catch (error) {
    console.error('Authorization error:', error.message);
    res.status(401).json({ error: 'Unauthorized access.' });
  }
};

// Create a new branch
router.post('/', authenticateSuperAdmin, upload.single('picture'), async (req, res) => {
  try {
    const branchData = JSON.parse(req.body.branch);
    let pictureUrl = null;

    if (req.file) {
      const uniqueFileName = `branch_images/${uuidv4()}-${req.file.originalname}`;
      pictureUrl = await uploadToStorage(req.file.buffer, uniqueFileName);
    }

    const branchRef = db.collection('branches').doc();
    const newBranch = {
      ...branchData,
      picture: pictureUrl || null,
      createdAt: FieldValue.serverTimestamp(),
    };

    await branchRef.set(newBranch);
    await invalidate(branchesListKey()); // new branch → list changed
    res.status(201).json({ id: branchRef.id, ...newBranch });
  } catch (error) {
    console.error('Error creating branch:', error.message);
    res.status(500).json({ error: 'Failed to create branch.' });
  }
});

// Get all branches
router.get('/', verifyAdminRole, async (req, res) => {
  try {
    // Same payload for every admin (no per-user filtering), so one shared key
    // is safe. Authorization still runs per request via verifyAdminRole above.
    const branches = await cached(branchesListKey(), BRANCHES_TTL, async () => {
      const branchesSnapshot = await db.collection('branches').get();
      return branchesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    });
    res.status(200).json(branches);
  } catch (error) {
    console.error('Error fetching branches:', error.message);
    res.status(500).json({ error: 'Failed to fetch branches.' });
  }
});

// Get a single branch by ID
router.get('/:id', verifyAdminRole, async (req, res) => {
  try {
    // Producer returns `undefined` for a missing branch so a 404 is never
    // cached (no negative caching); existing docs are cached by id.
    const branch = await cached(branchDocKey(req.params.id), BRANCHES_TTL, async () => {
      const branchRef = db.collection('branches').doc(req.params.id);
      const branchSnapshot = await branchRef.get();
      if (!branchSnapshot.exists) return undefined;
      return { id: branchSnapshot.id, ...branchSnapshot.data() };
    });

    if (branch === undefined) {
      return res.status(404).json({ error: 'Branch not found.' });
    }

    res.status(200).json(branch);
  } catch (error) {
    console.error('Error fetching branch:', error.message);
    res.status(500).json({ error: 'Failed to fetch branch.' });
  }
});

// Update a branch by ID
router.put('/:id', authenticateSuperAdmin, upload.single('picture'), async (req, res) => {
  try {
    const branchRef = db.collection('branches').doc(req.params.id);
    const branchData = JSON.parse(req.body.branch);
    let pictureUrl = null;

    if (req.file) {
      const uniqueFileName = `branch_images/${uuidv4()}-${req.file.originalname}`;
      pictureUrl = await uploadToStorage(req.file.buffer, uniqueFileName);
    }

    const updatedBranch = {
      ...branchData,
      picture: pictureUrl || branchData.picture || null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    await branchRef.update(updatedBranch);
    await invalidate(branchesListKey(), branchDocKey(req.params.id));
    res.status(200).json({ id: req.params.id, ...updatedBranch });
  } catch (error) {
    console.error('Error updating branch:', error.message);
    res.status(500).json({ error: 'Failed to update branch.' });
  }
});

// Delete a branch by ID
router.delete('/:id', authenticateSuperAdmin, async (req, res) => {
  try {
    const branchRef = db.collection('branches').doc(req.params.id);
    const branchSnapshot = await branchRef.get();

    if (!branchSnapshot.exists) {
      return res.status(404).json({ error: 'Branch not found.' });
    }

    await branchRef.delete();
    await invalidate(branchesListKey(), branchDocKey(req.params.id));
    res.status(204).end();
  } catch (error) {
    console.error('Error deleting branch:', error.message);
    res.status(500).json({ error: 'Failed to delete branch.' });
  }
});

module.exports = router;