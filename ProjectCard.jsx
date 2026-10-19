import React from "react";

export default function ProjectCard({ title = "My Project", description = "Project description goes here." }) {
  return (
    <div className="project-card">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
