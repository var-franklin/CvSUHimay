'use strict';

const NOTIFICATION_TYPES = new Set([
  'achievement',
  'enrollment',
  'enrollment_request',
  'level_up',
  'announcement',
  'quiz',
  'student_progress',
  'new_user',
  'course_created',
  'instructor_application_submitted',
  'instructor_application_approved',
  'instructor_application_rejected',
  'all_modules_completed',
  'reapply_request',
  'enrollment_left',   
  'enrollment_cancelled',
  'removed_from_course', 
  'course_archived',     
  'course_deleted',  
]);

module.exports = { NOTIFICATION_TYPES };
