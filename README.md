# 🐟 CvSUHimay

**A 3D interactive web simulator that teaches fisheries students how to debone bangus (milkfish) — with real-time mistake detection, gamified progress, and a full learning-management system built around it.**

*(Internally named **BoneUp** in the frontend package.)*

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white&style=flat-square)
![Three.js](https://img.shields.io/badge/Three.js-React_Three_Fiber-black?logo=three.js&logoColor=white&style=flat-square)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white&style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-Express_5-339933?logo=node.js&logoColor=white&style=flat-square)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white&style=flat-square)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white&style=flat-square)

---

## Table of Contents

- [About](#about)
- [Features](#features)
- [The Simulation Engine](#the-simulation-engine)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [API Overview](#api-overview)
- [My Contributions](#my-contributions)
- [Team & Acknowledgments](#team--acknowledgments)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## About

Fisheries students at Cavite State University – Naic Campus have traditionally learned bangus (milkfish) deboning through hands-on lab demonstrations — limited by contact hours, demonstrator availability, and specimen access. **CvSUHimay** addresses this with a web-based 3D simulator: students perform the full deboning procedure on a virtual bangus, get real-time feedback when they deviate from correct technique, and have their progress tracked through an integrated learning-management platform with courses, quizzes, and gamification.

Built as an undergraduate thesis project, the system was evaluated by 10 assessors (IT experts, faculty, and students) using the ISO 25010 software quality standard, scoring an overall 4.94/5 ("Excellent" across all eight quality characteristics) with all system test cases passing.

## Features

### 🎓 Student
- Onboarding flow and a personal dashboard summarizing simulation performance, module/quiz completion, XP, and rank
- Five structured learning modules with a distraction-free reader view
- Per-module quizzes, graded server-side with immediate feedback and explanations
- An illustrated bangus deboning reference guide (anatomy, tools, and procedure)
- The 3D deboning simulator itself — 11 guided procedural steps with hints (at a score penalty), real-time error feedback, and a completion screen breaking down score, time, and XP earned
- Gamification: XP and rank progression, a leaderboard (XP / quiz / simulation / achievements), and 21 achievements across rarity tiers (equip up to 3 on your public profile)
- In-app notifications and account/profile settings (avatar, username, password)

### 🧑‍🏫 Instructor
- Course creation and management with join codes, enrollment approval, and class announcements
- Student roster management, including reviewing pending enrollment requests
- Custom grading rules for the simulation
- Analytics: per-class and per-student quiz and simulation performance, hardest questions, learning-curve trends

### 🛠️ Admin
- User management across all roles
- Platform-wide activity logs
- System settings

## The Simulation Engine

The deboning procedure is modeled as a **Mealy-type Finite State Machine (FSM)**: each of the 11 steps is a state, and transitions are driven by the learner's actions in the 3D scene. Incorrect tool use or an out-of-sequence action is caught immediately and surfaced as feedback, rather than allowing the student to silently proceed with the wrong technique.

The 3D scene itself is built with **React Three Fiber** (Three.js) and uses **Draco compression** to keep the bangus models performant in-browser — the full mesh set was batched into a small number of compressed atlas models rather than shipped as dozens of individual full-resolution meshes, and a locally-hosted Draco WASM decoder ensures consistent loading across browsers, including on restricted campus networks.

## Tech Stack

**Frontend** — `web/` ("boneup-web")
- [React 19](https://react.dev/) + [Vite 7](https://vite.dev/)
- [React Three Fiber](https://r3f.docs.pmnd.rs/) + [drei](https://github.com/pmndrs/drei) + [Three.js](https://threejs.org/) for the 3D simulation
- [GSAP](https://gsap.com/) for animation
- [Tailwind CSS v4](https://tailwindcss.com/)
- [React Router DOM v7](https://reactrouter.com/)
- [Recharts](https://recharts.org/) for analytics charts
- [react-hot-toast](https://react-hot-toast.com/) for notifications
- [@react-oauth/google](https://www.npmjs.com/package/@react-oauth/google) for Google sign-in

**Backend** — `backend/`
- [Node.js](https://nodejs.org/) + [Express 5](https://expressjs.com/)
- [MySQL](https://www.mysql.com/) (via `mysql2`) — a 23-table relational schema covering users, courses, quiz attempts, simulation logs/scoring, achievements, and audit logs
- [jsonwebtoken](https://www.npmjs.com/package/jsonwebtoken) for authentication, with server-side token verification and revocation support
- [google-auth-library](https://www.npmjs.com/package/google-auth-library) for Google OAuth
- [express-rate-limit](https://www.npmjs.com/package/express-rate-limit) on auth endpoints
- [zod](https://zod.dev/) for request validation
- [multer](https://www.npmjs.com/package/multer) for avatar uploads
- [bcryptjs](https://www.npmjs.com/package/bcryptjs) for password hashing

## Project Structure

```
CvSUHimay/
├── backend/
│   ├── src/
│   │   ├── data/quiz/           # Per-module quiz question banks (JSON)
│   │   ├── middleware/          # auth, role guards (student/instructor/admin-only)
│   │   ├── routes/              # One router per domain (see API Overview)
│   │   ├── utils/               # Gamification, achievements, audit/activity logs, DB bootstrap
│   │   ├── db.js                # MySQL connection pool
│   │   └── server.js            # App entry point
│   ├── createAdmin.js           # CLI script to (re)create the admin account
│   └── db.sql                   # Full database schema
├── web/
│   ├── public/
│   │   ├── models/              # Bangus & bone 3D models (.glb, Draco-compressed)
│   │   ├── equipments/          # Tool models (knife, forceps, faucet, etc.)
│   │   └── draco/               # Local Draco WASM decoder
│   └── src/
│       ├── pages/
│       │   ├── auth/            # Sign in / get started
│       │   └── dashboards/      # student/, instructor/, admin/ dashboards
│       ├── simulation/          # The 3D deboning simulation engine
│       │   ├── components/      # camera, environment, fish, tools, steps, ui
│       │   ├── fsm/             # FSM provider & state logic
│       │   └── config/          # Fish, FSM, and step configuration
│       └── context/              # Auth/app-wide React context
├── screenshots/                  # (add the images from this README here)
└── package.json                  # Root script to run frontend + backend together
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher, with npm
- A running [MySQL](https://www.mysql.com/) server (local install or hosted)
- A [Google OAuth Client ID](https://console.cloud.google.com/apis/credentials) (needed for Google sign-in — the app still starts without one, but Google sign-in won't work)

### Installation

**1. Clone the repository**

```bash
git clone https://github.com/var-franklin/CvSUHimay.git
cd CvSUHimay
```

**2. Set up the database**

```bash
mysql -u root -p < backend/db.sql
```

This creates the `cvsuhimay_db` database and its full schema.

**3. Set up the backend**

```bash
cd backend
npm install
```

Create a `.env` file in `backend/`:

```env
DB_HOST=localhost
DB_USER=root
DB_PASS=your_mysql_password
DB_NAME=cvsuhimay_db
PORT=4000
JWT_SECRET=choose_a_long_random_string
GOOGLE_CLIENT_ID=your_google_oauth_client_id
```

Start the backend:

```bash
npm run dev
```

The API runs at `http://localhost:4000`.

**4. Set up the frontend**

In a new terminal:

```bash
cd web
npm install
```

Create a `.env` file in `web/`:

```env
VITE_API_URL=http://localhost:4000
VITE_GOOGLE_CLIENT_ID=your_google_oauth_client_id
```

Start the frontend:

```bash
npm run dev
```

The app will be available at `http://localhost:5173`.

> Alternatively, after installing both sets of dependencies, `npm run dev` from the repo root uses `concurrently` to start both at once.

### Creating an Admin Account

Admin accounts aren't self-registered. From `backend/`, run:

```bash
node createAdmin.js
```

This creates `admin@cvsuhimay.edu.ph` with password `admin123` — change this password after first login.

## API Overview

All endpoints are served from the Express backend, organized into one router per domain under `backend/src/routes/`.

| Route Group | Base Path | Covers |
|---|---|---|
| Auth | `/api/auth` | Register, login, Google sign-in/sign-up, current-user check |
| Users | `/api/users` | User directory & stats, role/status changes, password resets |
| Instructor | `/api/instructor` | Student roster & pending approvals, grading rules, dashboard stats, quiz analytics |
| Student | `/api/student` | Instructor discovery & enrollment, student profile & dashboard stats |
| Courses | `/api/courses` | Course browsing, join codes, enrollment approval, announcements, classmates |
| Modules | `/api/module` | Module completion & progress tracking |
| Quizzes | `/api/quiz` | Quiz questions, submission & grading, attempt history |
| Profile | `/api/profile` | Profile & avatar management, password/email changes, public profiles |
| Achievements | `/api/achievements` | Achievement listing & progress |
| Onboarding | `/api/onboarding` | Onboarding & product-tour completion flags |
| Leaderboard | `/api/leaderboard` | XP, quiz, simulation, and achievement leaderboards |
| Notifications | `/api/notifications` | In-app notifications |
| Sessions | `/api/sessions` | Active session listing |
| Settings | `/api/settings` | Notification, gamification, and accessibility preferences |
| Simulation | `/api/sim` | Simulation session logging & analytics (student/course/instructor/learning-curve) |
| Admin | `/api/admin` | Activity log review |
| Account | `/api/account` | Data export & account management |
| Rules / Attempts | `/api/rules`, `/api/attempts` | Instructor-defined grading rules and student attempt records |

## My Contributions

This was a 3-person undergraduate thesis. My (Franklin's) primary focus areas were:

- **Backend:** the complete REST API (Node.js/Express), the MySQL schema, JWT authentication, and Google OAuth integration
- **FSM:** architected the baseline state schema and finalized the state/transition configuration for the Mealy-type validation engine
- **Performance:** diagnosed 3D rendering performance bottlenecks and integrated Draco compression — batching the individual bone meshes into a small set of compressed atlas models — and configured the Draco WASM decoder locally for consistent cross-browser loading
- **Frontend:** the UI/UX component system (Tailwind), the gamification module (XP, ranks, achievements, leaderboard), and the instructor analytics dashboard

3D character/environment modeling, asset creation, and the individual simulation step mechanics were built by my teammates.

## Team & Acknowledgments

- **Jhon Lorence A. Hilario**
- **Gavriell C. Pangan**
- **Franklin Gian G. Sarmiento** ([github.com/var-franklin](https://github.com/var-franklin))

Undergraduate thesis, BS Computer Science, Cavite State University – Naic Campus. Advised by Dr. Michelle C. Tanega.

## Known Limitations

Per the thesis's own stated scope, a few boundaries are worth being upfront about:

- The simulation models bangus (milkfish) deboning specifically — it doesn't generalize to other fish species or commercial-scale processing.
- 3D rendering performance depends on the user's device and browser, since the simulation runs client-side.
- The FSM captures procedural sequence but not finer physical nuances like exact tool pressure or micro-motion.
- Learning content is tied to CvSU–Naic's specific curriculum; updates require manual changes to the platform.
- Analytics are quantitative only (time spent, error counts, material access) — they don't capture reasoning or learning strategy.
- Feedback is rule-based rather than adaptive to individual learning styles or skill levels.
- Evaluation was conducted with a single institution's students and faculty, so results may not generalize elsewhere.

## License

This project does not currently have an open-source license. All rights are reserved by the authors.
